// lib/monitoring/alerts/evaluate.ts — one run: metrics → rules → diff → events → deliver (spec §5).
import { evaluateAll } from "./rules";
import { diffStates, runSlot } from "./state";
import { narrateDigest, narrateTransition, type NarrateDeps } from "./narrate";
import { deliver, digestMessage, transitionMessage, type DeliverDeps, type Delivery } from "./deliver";
import { supabaseAlertRepo, type AlertRepo } from "./repo";
import type { AlertRule, MetricsInput, Observation, Transition, WindowMetrics } from "./types";

export interface EvaluateOptions { slot: "scheduled" | "test" | "manual"; dryRun?: boolean; now?: Date; env?: string; dashboardUrl?: string; tz?: string }
export interface EvaluateDeps { repo?: AlertRepo; narrate?: NarrateDeps; deliver?: DeliverDeps }
export interface EvaluateResult {
  ok: boolean; slot: string; dryRun: boolean;
  transitions: { kind: "fired" | "recovered"; rule_key: string; agent: string; subkey: string; observed: number | null; threshold: number; narrative: string; delivery?: Delivery }[];
  digest: { sent: boolean; narrative: string; delivery?: Delivery };
  observations: { rule_key: string; agent: string; subkey: string; status: string; observed: number | null; threshold: number; samples: number; note?: string }[];
  errored: string[];
}

export function dashboardUrl(env: NodeJS.ProcessEnv = process.env): string {
  const host = env.ALERT_DASHBOARD_URL?.trim() || (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://127.0.0.1:3001");
  return `${host.replace(/\/$/, "")}/monitoring/alerts`;
}

export async function runEvaluation(opts: EvaluateOptions, deps: EvaluateDeps = {}): Promise<EvaluateResult | undefined> {
  const repo = "repo" in deps ? deps.repo : supabaseAlertRepo();
  if (!repo) return undefined;
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const env = opts.env ?? "production";
  const tz = opts.tz ?? "Europe/Berlin";
  const slot = runSlot(opts.slot, now, tz);
  const url = opts.dashboardUrl ?? dashboardUrl();

  const [allRules, prevStates, settings] = await Promise.all([repo.rules(), repo.states(), repo.settings()]);
  const rules = allRules.filter((r) => r.enabled);

  // Metrics: one window call per distinct window_hours, one cost-day call; per-call failures mark rules errored.
  const errored: string[] = [];
  const hoursList = [...new Set(rules.map((r) => r.window_hours))];
  const windows: Record<number, WindowMetrics> = {};
  await Promise.all(hoursList.map(async (h) => { try { windows[h] = await repo.window(env, h); } catch { /* rules on this window become errored below */ } }));
  const needsCost = rules.some((r) => r.key === "cost_daily" || r.key === "cost_spike");
  let costDay: MetricsInput["costDay"] | undefined;
  if (needsCost) { try { costDay = await repo.costDay(env, tz, Math.max(...rules.filter((r) => r.key === "cost_spike").map((r) => Number(r.params.baseline_days ?? 7)), 7)); } catch { /* cost rules errored */ } }

  const evaluable: AlertRule[] = [];
  for (const r of rules) {
    const costRule = r.key === "cost_daily" || r.key === "cost_spike";
    const missingWindow = !windows[r.window_hours] && r.key !== "cost_daily";
    if ((costRule && !costDay) || missingWindow) { if (!errored.includes(r.key)) errored.push(r.key); continue; }
    evaluable.push(r);
  }
  const metrics: MetricsInput = { windows, costDay: costDay ?? { today: { faq: 0, partner: 0, total: 0 }, baseline_days: 0, baseline_avg: { faq: 0, partner: 0, total: 0 } } };
  const observations: Observation[] = evaluateAll(evaluable, metrics);
  const { transitions, next: evaluatedNext } = diffStates(prevStates, observations, nowIso);
  // Rows for rules that errored this run (or otherwise weren't evaluated) are left untouched:
  // merge them back in so saveStates sees the full, unchanged state rather than dropping them.
  const touchedKeys = new Set(evaluatedNext.map((s) => `${s.rule_id}|${s.agent}|${s.subkey}`));
  const untouched = prevStates.filter((s) => !touchedKeys.has(`${s.rule_id}|${s.agent}|${s.subkey}`));
  const next = [...evaluatedNext, ...untouched];

  // Narrate first (needed for both dry-run preview and real events).
  const narrated = await Promise.all(transitions.map(async (t) => ({ t, n: await narrateTransition(t, deps.narrate) })));
  const digestNarr = await narrateDigest(observations, errored, deps.narrate);

  const result: EvaluateResult = {
    ok: true, slot, dryRun: Boolean(opts.dryRun),
    transitions: narrated.map(({ t, n }) => ({ kind: t.kind, rule_key: t.obs.rule.key, agent: t.obs.agent, subkey: t.obs.subkey, observed: t.obs.observed, threshold: t.obs.threshold, narrative: n.text })),
    digest: { sent: false, narrative: digestNarr.text },
    observations: observations.map((o) => ({ rule_key: o.rule.key, agent: o.agent, subkey: o.subkey, status: o.status, observed: o.observed, threshold: o.threshold, samples: o.samples, ...(o.note ? { note: o.note } : {}) })),
    errored,
  };
  if (opts.dryRun) return result;

  await repo.saveStates(next);
  const recipients = settings.email_recipients;
  const windowFrom = (t: Transition) => new Date(now.getTime() - t.obs.rule.window_hours * 3_600_000).toISOString();

  for (const [i, { t, n }] of narrated.entries()) {
    const ins = await repo.insertEvent({
      kind: t.kind, rule_key: t.obs.rule.key, agent: t.obs.agent, subkey: t.obs.subkey, severity: t.obs.rule.severity,
      observed: t.obs.observed, threshold: t.obs.threshold, samples: t.obs.samples, window_hours: t.obs.rule.window_hours,
      window_from: windowFrom(t), window_to: nowIso, narrative: n.text, narrative_source: n.source, run_slot: slot,
    });
    const d = await deliver(transitionMessage(t, n.text, url), { teams: true, email: true }, { ...deps.deliver, recipients });
    result.transitions[i].delivery = d;
    if (ins.id) await repo.updateEventDelivery(ins.id, d);
  }

  const ins = await repo.insertEvent({ kind: "digest", narrative: digestNarr.text, narrative_source: digestNarr.source, run_slot: slot });
  if (ins.inserted && settings.digest_enabled && opts.slot === "scheduled") {
    const d = await deliver(digestMessage(observations, errored, digestNarr.text, url), { teams: true, email: false }, { ...deps.deliver, recipients });
    result.digest = { sent: d.teams === "sent", narrative: digestNarr.text, delivery: d };
    if (ins.id) await repo.updateEventDelivery(ins.id, d);
  }
  return result;
}

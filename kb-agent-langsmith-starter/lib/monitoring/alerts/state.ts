// lib/monitoring/alerts/state.ts — PURE transition logic + run-slot naming (spec §5).
import type { AlertRule, AlertStateRow, Observation, Transition } from "./types";

const keyOf = (ruleId: string, agent: string, subkey: string) => `${ruleId}|${agent}|${subkey}`;

/**
 * Diff the freshly observed state against what is stored.
 *
 * `evaluatedRules` are the rules this run actually evaluated. A stored row that belongs to one
 * of them but received NO observation this run (an `error_repeat` subkey whose error type has
 * stopped occurring, say) is treated as `ok`; if it was `breached` that is a `recovered`
 * transition. Without this, such a row would stay `breached` forever — no recovery message, a
 * permanent banner, and the rule could never fire for that key again (spec section 5).
 * Rows of rules that were not evaluated are left untouched here (disabled rules are deleted by
 * the caller).
 */
export function diffStates(prev: AlertStateRow[], obs: Observation[], nowIso: string, evaluatedRules: AlertRule[] = []): { transitions: Transition[]; next: AlertStateRow[] } {
  const before = new Map(prev.map((p) => [keyOf(p.rule_id, p.agent, p.subkey), p]));
  const transitions: Transition[] = [];
  const next: AlertStateRow[] = [];
  const seen = new Set<string>();
  const rulesById = new Map(evaluatedRules.map((r) => [r.id, r]));

  for (const o of obs) {
    const k = keyOf(o.rule.id, o.agent, o.subkey);
    seen.add(k);
    const p = before.get(k);
    const wasBreached = p?.status === "breached";
    let status: AlertStateRow["status"] = o.status === "skipped" ? (p?.status ?? "ok") : o.status;
    let transitionAt = p?.last_transition_at ?? null;

    if (o.status === "breached" && !wasBreached) { transitions.push({ kind: "fired", obs: o }); transitionAt = nowIso; status = "breached"; }
    else if (o.status === "ok" && wasBreached) { transitions.push({ kind: "recovered", obs: o }); transitionAt = nowIso; status = "ok"; }

    next.push({
      rule_id: o.rule.id, agent: o.agent, subkey: o.subkey, status,
      observed: o.status === "skipped" ? (p?.observed ?? null) : o.observed,
      samples: o.status === "skipped" ? (p?.samples ?? null) : o.samples,
      last_evaluated_at: nowIso, last_transition_at: transitionAt,
    });
  }

  // Reconcile rows whose observation vanished this run.
  for (const p of prev) {
    const k = keyOf(p.rule_id, p.agent, p.subkey);
    if (seen.has(k)) continue;
    const rule = rulesById.get(p.rule_id);
    if (!rule) continue;
    const wasBreached = p.status === "breached";
    if (wasBreached) {
      const obsOut: Observation = {
        rule, agent: p.agent as Observation["agent"], subkey: p.subkey, status: "ok",
        observed: 0, samples: 0, threshold: rule.threshold, note: "im Fenster nicht mehr aufgetreten",
      };
      transitions.push({ kind: "recovered", obs: obsOut });
    }
    next.push({
      rule_id: p.rule_id, agent: p.agent, subkey: p.subkey, status: "ok",
      observed: null, samples: null,
      last_evaluated_at: nowIso, last_transition_at: wasBreached ? nowIso : p.last_transition_at,
    });
  }
  return { transitions, next };
}

export function berlinParts(now: Date, tz = "Europe/Berlin"): { date: string; hour: string; minute: string } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
    .formatToParts(now)
    .reduce<Record<string, string>>((acc, p) => (p.type !== "literal" ? { ...acc, [p.type]: p.value } : acc), {});
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: parts.hour === "24" ? "00" : parts.hour, minute: parts.minute };
}

export function runSlot(slot: "scheduled" | "test" | "manual", now: Date, tz = "Europe/Berlin"): string {
  const { date, hour, minute } = berlinParts(now, tz);
  return slot === "scheduled" ? `${date}T${hour}` : `${slot}:${date}T${hour}:${minute}`;
}

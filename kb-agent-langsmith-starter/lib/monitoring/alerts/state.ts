// lib/monitoring/alerts/state.ts — PURE transition logic + run-slot naming (spec §5).
import type { AlertStateRow, Observation, Transition } from "./types";

const keyOf = (ruleId: string, agent: string, subkey: string) => `${ruleId}|${agent}|${subkey}`;

export function diffStates(prev: AlertStateRow[], obs: Observation[], nowIso: string): { transitions: Transition[]; next: AlertStateRow[] } {
  const before = new Map(prev.map((p) => [keyOf(p.rule_id, p.agent, p.subkey), p]));
  const transitions: Transition[] = [];
  const next: AlertStateRow[] = [];

  for (const o of obs) {
    const k = keyOf(o.rule.id, o.agent, o.subkey);
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

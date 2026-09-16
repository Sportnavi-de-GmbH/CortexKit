// components/monitoring/selection.ts — pure selection-set helpers shared by
// TraceList / AlertFeed row checkboxes and DeleteBar, plus the German
// confirm-dialog body text (spec §5). No React, no DOM — testable directly.

export function toggle(set: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export function selectAll(set: ReadonlySet<string>, ids: string[]): Set<string> {
  const next = new Set(set);
  for (const id of ids) next.add(id);
  return next;
}

export function clearAll(): Set<string> {
  return new Set();
}

export function allSelected(set: ReadonlySet<string>, ids: string[]): boolean {
  if (ids.length === 0) return false;
  return ids.every((id) => set.has(id));
}

/** The German confirm-dialog body text for deleting `n` traces or alerts. */
export function deleteBody(kind: "trace" | "alert", n: number): string {
  if (kind === "trace") {
    const noun = n === 1 ? "Ausführung" : "Ausführungen";
    const verb = n === 1 ? "wird" : "werden";
    return `${n} ${noun} samt Schritten, Fehlern und Bewertungen ${verb} endgültig gelöscht. Leere Sitzungen werden ebenfalls entfernt.`;
  }
  const noun = n === 1 ? "Meldung" : "Meldungen";
  const verb = n === 1 ? "wird" : "werden";
  return `${n} ${noun} ${verb} endgültig gelöscht. Der aktuelle Alarmstatus bleibt unverändert.`;
}

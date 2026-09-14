/**
 * Pure assembly of the final answer from the per-task results. No model
 * call: the model never sees more than one task's partners, so it cannot
 * mix them up or invent a cross-task summary.
 */
import type { Task, TaskRun } from "./types";

export const CLARIFICATION = "In welcher Stadt (oder Umgebung) suchst du? Sag mir kurz den Ort, dann finde ich passende Angebote.";

export function clarificationFor(labels: string[]): string {
  return `Kurze Frage, bevor ich weitersuche 😄 – für „${labels.join("” und „")}”: in welcher Stadt (oder Umgebung) soll ich schauen?`;
}

export function deferredNote(labels: string[]): string {
  return `(Notiert für danach: ${labels.join(", ")} – sag einfach Bescheid, dann suche ich weiter.)`;
}

export function failedSection(label: string): string {
  return `**${label}**\nBei „${label}” ist gerade etwas schiefgelaufen – versuch es gleich noch einmal.`;
}

export function compose(args: { tasks: TaskRun[]; deferred: Task[] }): { answer?: string; clarification?: string; pending: Task[] } {
  const pending = args.tasks.filter((t) => t.status === "needs_clarification").map((t) => t.task);

  // Exactly what the single-task lab produced before stage 0 existed.
  if (args.tasks.length === 1 && args.deferred.length === 0) {
    const t = args.tasks[0]!;
    if (t.status === "ok") return { answer: t.answer, pending };
    if (t.status === "needs_clarification") return { clarification: CLARIFICATION, pending };
    return { pending };
  }

  const parts: string[] = [];
  for (const t of args.tasks) {
    if (t.status === "ok") parts.push(`**${t.task.label}**\n${t.answer ?? ""}`);
    else if (t.status === "failed") parts.push(failedSection(t.task.label));
  }
  let clarification: string | undefined;
  if (pending.length) {
    clarification = clarificationFor(pending.map((p) => p.label));
    parts.push(clarification);
  }
  if (args.deferred.length) parts.push(deferredNote(args.deferred.map((d) => d.label)));
  return { answer: parts.join("\n\n"), ...(clarification ? { clarification } : {}), pending };
}
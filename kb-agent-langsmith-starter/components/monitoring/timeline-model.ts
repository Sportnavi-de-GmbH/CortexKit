// Pure layout helpers for the trace timeline (tested; no JSX here).
import type { StepNode } from "@/lib/monitoring/query";
import type { StepKind } from "@/lib/monitoring/types";

/** 0..100 share of the trace; never below 2 for a real duration so it stays visible. */
export function durationPct(step: { duration_ms: number | null }, total: number): number {
  if (!step.duration_ms || total <= 0) return 0;
  return Math.max(2, Math.min(100, Math.round((step.duration_ms / total) * 100)));
}

export type LayoutRow = { kind: "step"; step: StepNode } | { kind: "lanes"; groups: StepNode[] };

/** Consecutive `group` steps (V3's parallel tasks) collapse into one side-by-side row. */
export function laneLayout(top: StepNode[]): LayoutRow[] {
  const rows: LayoutRow[] = [];
  for (const s of top) {
    const last = rows.at(-1);
    if (s.kind === "group") {
      if (last?.kind === "lanes") last.groups.push(s);
      else rows.push({ kind: "lanes", groups: [s] });
    } else {
      rows.push({ kind: "step", step: s });
    }
  }
  return rows;
}

export interface StepTable {
  columns: string[];
  rows: Record<string, unknown>[];
}

const pick = (rows: unknown, cols: string[]): StepTable | null =>
  Array.isArray(rows) && rows.length
    ? { columns: cols, rows: rows.map((r) => Object.fromEntries(cols.map((c) => [c, (r as Record<string, unknown>)[c]]))) }
    : null;

/** Tabular view for the list-shaped outputs; null when the raw JSON is the best view. */
export function tableFor(step: Pick<StepNode, "name" | "output">): StepTable | null {
  const out = (step.output ?? {}) as Record<string, unknown>;
  if (step.name === "search") return pick(out.candidates, ["id", "name", "city", "role", "distanceKm", "similarity", "rankInCity"]);
  if (step.name === "rerank") return pick(out.rows, ["rank", "name", "city", "role", "relevance", "locationTerm", "finalScore", "kept", "dropReason"]);
  if (step.name === "respond") return pick(out.recommendations, ["rank", "name", "city", "role", "distanceKm", "finalScore"]);
  return null;
}

/** Flattened visible order for keyboard navigation: parents before their (open) children. */
export function visibleOrder(top: StepNode[], open: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const walk = (n: StepNode) => {
    out.push(n.id);
    if (n.kind === "group" || open.has(n.id)) n.children.forEach(walk);
  };
  top.forEach(walk);
  return out;
}

export function allIds(top: StepNode[]): string[] {
  const out: string[] = [];
  const walk = (n: StepNode) => {
    out.push(n.id);
    n.children.forEach(walk);
  };
  top.forEach(walk);
  return out;
}

export const KIND_LABEL: Record<StepKind, string> = {
  request: "Request",
  llm: "Model call",
  tool: "Tool",
  retrieval: "Lookup",
  transform: "Processing",
  response: "Response",
  error: "Error",
  group: "Task",
};

/** Compact JSON preview for a collapsed card. */
export function previewOf(value: unknown, max = 120): string {
  if (value === null || value === undefined) return "";
  const s = typeof value === "string" ? value : JSON.stringify(value);
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

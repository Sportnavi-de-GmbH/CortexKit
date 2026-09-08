// Pure computation for the feedback statistics and the promote routing —
// everything scripts/feedback-report.ts and scripts/feedback-promote.ts decide
// lives here, side-effect-free, so tests can pin the arithmetic offline.

import { REASONS, REVIEW_VERDICTS, type ReviewVerdict } from "./feedback-taxonomy";

/** The subset of a Langfuse v3 score row these computations read. */
export interface ScoreRow {
  id: string;
  name: string;
  value?: number;
  /** Categorical scores carry their category label here. */
  stringValue?: string;
  traceId?: string;
  sessionId?: string;
  comment?: string | null;
  environment?: string;
  timestamp?: string; // ISO
  source?: string; // API | ANNOTATION | EVAL
}

/**
 * Raw `/api/public/v3/scores` row → normalized ScoreRow. v3 puts a NUMERIC
 * score's number and a CATEGORICAL score's label in the SAME `value` field,
 * and moves the trace/session linkage into a `subject` object that is only
 * present when the request asked for `fields=…,subject` (measured live —
 * without it, every vote looks session-less).
 */
export function fromV3Row(raw: Record<string, unknown>): ScoreRow {
  const subject = raw.subject as { kind?: string; id?: string } | null | undefined;
  const metadata = (raw.metadata ?? {}) as Record<string, unknown>;
  // A score upgraded by feedback:reconcile is re-created (the API cannot move
  // a subject in place, nor accept a timestamp), so it carries the vote's real
  // time in metadata — statistics must not count it as a fresh vote.
  const original = metadata.originalTimestamp;
  return {
    id: String(raw.id ?? ""),
    name: String(raw.name ?? ""),
    value: typeof raw.value === "number" ? raw.value : undefined,
    stringValue: typeof raw.value === "string" ? raw.value : undefined,
    traceId: subject?.kind === "trace" ? subject.id : undefined,
    sessionId: subject?.kind === "session" ? subject.id : undefined,
    comment: (raw.comment as string | null | undefined) ?? null,
    environment: typeof raw.environment === "string" ? raw.environment : undefined,
    timestamp:
      typeof original === "string"
        ? original
        : typeof raw.timestamp === "string"
          ? raw.timestamp
          : undefined,
    source: typeof raw.source === "string" ? raw.source : undefined,
  };
}

/**
 * Which trace answered `turn_N` of a session, from ANY of that session's
 * observations: traces ordered by their earliest observation ARE the turn
 * order (eve numbers turns per session from 0, failed turns included, and
 * every turn leaves at least one span). No local state involved — this is
 * what makes trace precision reachable on a serverless instance that never
 * saw the turn. Returns undefined when the ordinal is not (yet) present: a
 * trace whose spans have not been ingested is invisible, and the caller
 * degrades to session precision rather than guessing.
 */
export function traceForTurn(
  observations: Array<{ traceId?: string; startTime?: string }>,
  turnId: string,
): string | undefined {
  const m = /^turn_(\d+)$/.exec(turnId);
  if (!m) return undefined;
  const n = Number(m[1]);
  const earliest = new Map<string, string>();
  for (const o of observations) {
    if (!o.traceId || !o.startTime) continue;
    const prev = earliest.get(o.traceId);
    if (!prev || o.startTime < prev) earliest.set(o.traceId, o.startTime);
  }
  const ordered = [...earliest.entries()].sort(
    (a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]),
  );
  return ordered[n]?.[0];
}

export interface WindowStats {
  total: number;
  up: number;
  down: number;
  /** 0..1, or null when the window holds no votes. */
  positiveRate: number | null;
  withComment: number;
  byEnvironment: Record<string, { up: number; down: number }>;
}

const inWindow = (r: ScoreRow, fromIso: string, toIso: string) =>
  (r.timestamp ?? "") >= fromIso && (r.timestamp ?? "") < toIso;

/**
 * Thumb statistics for one time window. Counts each score ROW once — the
 * deterministic id means a re-vote UPDATED the row, so rows are already
 * per-(session,turn) and need no extra dedupe.
 */
export function windowStats(scores: ScoreRow[], fromIso: string, toIso: string): WindowStats {
  const votes = scores.filter(
    (r) => r.name === "user-feedback" && typeof r.value === "number" && inWindow(r, fromIso, toIso),
  );
  const up = votes.filter((r) => r.value === 1).length;
  const down = votes.filter((r) => r.value === 0).length;
  const byEnvironment: WindowStats["byEnvironment"] = {};
  for (const v of votes) {
    const env = v.environment ?? "unknown";
    byEnvironment[env] ??= { up: 0, down: 0 };
    if (v.value === 1) byEnvironment[env].up++;
    else byEnvironment[env].down++;
  }
  return {
    total: votes.length,
    up,
    down,
    positiveRate: votes.length === 0 ? null : up / votes.length,
    withComment: votes.filter((r) => (r.comment ?? "").trim() !== "").length,
    byEnvironment,
  };
}

export interface HistogramEntry {
  value: string;
  count: number;
  /** For feedback reasons: the objective trace metric to check against. */
  correlate?: string;
}

/** Count categorical score values in a window, most frequent first. */
export function histogram(
  scores: ScoreRow[],
  scoreName: string,
  fromIso: string,
  toIso: string,
): HistogramEntry[] {
  const counts = new Map<string, number>();
  for (const r of scores) {
    if (r.name !== scoreName || !inWindow(r, fromIso, toIso)) continue;
    const v = (r.stringValue ?? "").trim();
    if (v === "") continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({
      value,
      count,
      correlate: REASONS.find((x) => x.code === value)?.correlate,
    }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

/**
 * The weekly spot-review sample: plain 👍 (no comment) in the window, newest
 * first, capped — deterministic so re-running the report names the same traces.
 */
export function samplePlainUps(
  scores: ScoreRow[],
  fromIso: string,
  toIso: string,
  n = 5,
): ScoreRow[] {
  return scores
    .filter(
      (r) =>
        r.name === "user-feedback" &&
        r.value === 1 &&
        (r.comment ?? "").trim() === "" &&
        r.traceId !== undefined &&
        inWindow(r, fromIso, toIso),
    )
    .sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? "") || a.id.localeCompare(b.id))
    .slice(0, n);
}

/** Positive rate per knowledge.version_digest — the before/after-a-change number. */
export function rateByDigest(
  votes: Array<{ value: number; digest: string | undefined }>,
): Array<{ digest: string; total: number; up: number; positiveRate: number }> {
  const byDigest = new Map<string, { total: number; up: number }>();
  for (const v of votes) {
    const d = v.digest ?? "(unknown)";
    const row = byDigest.get(d) ?? { total: 0, up: 0 };
    row.total++;
    if (v.value === 1) row.up++;
    byDigest.set(d, row);
  }
  return [...byDigest.entries()]
    .map(([digest, r]) => ({ digest, ...r, positiveRate: r.up / r.total }))
    .sort((a, b) => b.total - a.total);
}

// ---------------------------------------------------------------------------
// Promote routing
// ---------------------------------------------------------------------------

export const GOLDEN_DATASET = "Feedback — Golden Answers";
export const REGRESSION_DATASET = "Feedback — Regressions";

/** Which dataset a completed review item belongs in, per its verdict. */
export function datasetForVerdict(verdict: string | undefined): string | null {
  const v = REVIEW_VERDICTS.find((x) => x.value === (verdict as ReviewVerdict));
  if (!v) return null;
  if (v.promote === "golden") return GOLDEN_DATASET;
  if (v.promote === "regression") return REGRESSION_DATASET;
  return null;
}

/** Latest review-verdict per trace id, from ANNOTATION scores. */
export function verdictByTrace(scores: ScoreRow[]): Map<string, string> {
  const latest = new Map<string, { value: string; ts: string }>();
  for (const r of scores) {
    if (r.name !== "review-verdict" || !r.traceId) continue;
    const v = (r.stringValue ?? "").trim();
    if (v === "") continue;
    const ts = r.timestamp ?? "";
    const prev = latest.get(r.traceId);
    if (!prev || ts > prev.ts) latest.set(r.traceId, { value: v, ts });
  }
  return new Map([...latest.entries()].map(([k, v]) => [k, v.value]));
}

/** Stable dataset-item id per trace — re-promoting is an update, not a dupe. */
export function datasetItemId(traceId: string): string {
  return `fb-${traceId}`;
}

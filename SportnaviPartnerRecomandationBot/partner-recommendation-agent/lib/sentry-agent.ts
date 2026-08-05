/**
 * Pure helpers behind the Sentry integration — classification, fingerprinting,
 * titling, scrubbing. Imports nothing from @sentry/*, so the whole surface is
 * unit-testable without a DSN, a network, or a running agent
 * (tests/sentry-agent.test.ts). agent/hooks/sentry.ts stays a thin mapping
 * from eve stream events onto these functions.
 *
 * Adapted from example/sentry-observability-agent/lib/sentry-agent.ts; the
 * classification is tuned to THIS project's dependencies: Supabase (partner
 * directory), the embedding API (similarity search), and Azure OpenAI.
 *
 * PRIVACY: this project's observability rules (lib/observability.ts) forbid
 * PII, partner names, and raw user text in any log sink. Nothing in this file
 * or the hook forwards user input, partner data, or intent text to Sentry —
 * only error messages, codes, and counts.
 */

export type FailureClass =
  | "runtime"
  | "agent"
  | "performance"
  | "unexpected"
  | "integration"
  | "external"
  | "fabrication";

export type Severity = "warning" | "error" | "fatal";

const SEVERITY: Record<FailureClass, Severity> = {
  unexpected: "warning",
  performance: "warning",
  runtime: "error",
  integration: "error",
  external: "error",
  // A failed turn means the user got nothing. That is the worst outcome here.
  agent: "fatal",
  // The user DID get an answer, so this is not as bad as "agent" — but a
  // possible fabrication is a direct violation of the product's core
  // invariant (CLAUDE.md §1: "Honesty outranks helpfulness"), so it is
  // not a mere "warning" either.
  fabrication: "error",
};

/** Dependency failures this agent can actually have, by message shape. */
const INTEGRATION_PATTERN = /supabase|postgrest|embedding|pgvector|ECONNREFUSED|fetch failed/i;

export function classify(err: unknown): FailureClass {
  const message =
    typeof err === "string"
      ? err
      : err instanceof Error
        ? err.message
        : String((err as { message?: unknown } | null)?.message ?? "");

  const status =
    (err as { status?: unknown } | null)?.status ??
    (err as { statusCode?: unknown } | null)?.statusCode;
  if (typeof status === "number" && status >= 400) return "external";

  if (INTEGRATION_PATTERN.test(message)) return "integration";

  return "runtime";
}

export function severityFor(failureClass: FailureClass): Severity {
  return SEVERITY[failureClass];
}

/**
 * A stable fingerprint so repeated identical failures collapse into ONE Sentry
 * issue (and one alert), instead of one per retry.
 */
export function fingerprintFor(failureClass: FailureClass, key: string): string[] {
  return ["partner-agent", failureClass, key];
}

export type SubjectKind = "tool" | "model step" | "turn" | "session";

/**
 * A scannable issue title: class in brackets, then the subject, then the
 * cause. Display-only — grouping is by the explicit fingerprint, so retitling
 * never forks an issue.
 */
export function titleFor(
  failureClass: FailureClass,
  subjectKind: SubjectKind,
  subject: string,
  cause: string,
): string {
  const head = subjectKind === "tool" && subject ? `tool '${subject}'` : subjectKind;
  const tail = cause ? `: ${cause}` : "";
  return `[${failureClass}] ${head} failed${tail}`;
}

const LABEL: Record<FailureClass, string> = {
  runtime: "Runtime exception (a tool threw)",
  agent: "Agent failure (turn or session aborted)",
  performance: "Performance issue (latency budget exceeded)",
  unexpected: "Unexpected behavior (malformed result)",
  integration: "Integration failure (Supabase / embedding API unavailable)",
  external: "External API failure (upstream 4xx/5xx)",
  fabrication: "Possible fabrication (reply names a partner not in this turn's search result)",
};

/** Plain-English companion to the alert-stable `failure.class` tag value. */
export function labelFor(failureClass: FailureClass): string {
  return LABEL[failureClass];
}

const SECRET_KEY = /key|token|password|secret|dsn|authorization|credential/i;

export function scrub(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET_KEY.test(k)) {
      out[k] = "[redacted]";
    } else if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      out[k] = scrub(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

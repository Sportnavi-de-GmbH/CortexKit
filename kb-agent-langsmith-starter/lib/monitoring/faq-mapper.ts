// Pure: eve hook events → partial TraceDrafts for the FAQ agent. Each function
// returns ONLY what that event knows; the RPC merges. Mirrors the journal in
// lib/langfuse.ts but writes rows instead of spans.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { FAILURE_PATTERNS, failureMessage } from "../langfuse";
import { describeStep } from "./describe";
import { usageCost } from "./pricing";
import type { StepDraft, TraceDraft } from "./types";

export interface FaqTurnState {
  sessionId: string;
  turnId?: string;
  startedAt?: number;
  question?: string;
  reply?: string;
  firstTokenAt?: number;
  stepStartedAt?: number;
  steps: number;
  usage: { input: number; output: number; cached: number };
  tools: string[];
  toolErrors: number;
}

export function freshFaqTurn(sessionId: string): FaqTurnState {
  return { sessionId, steps: 0, usage: { input: 0, output: 0, cached: 0 }, tools: [], toolErrors: 0 };
}

export interface FaqMapperEnv {
  agentVersion: string;
  environment: string;
  model: string;
  channel?: string;
  origin?: string | null;
}

/**
 * Per-session turn state on disk, so a fragment that lands on a different
 * serverless invocation (CLAUDE.md serverless traps) still knows the turn id
 * and start time. Same best-effort pattern as lib/langfuse.ts' fileStore.
 */
const DIR = process.env.VERCEL ? "/tmp/navio-monitoring/turns" : ".data/monitoring/turns";
const pathFor = (sessionId: string) => `${DIR}/${encodeURIComponent(sessionId)}.json`;
export const turnStateStore = {
  set(s: FaqTurnState): void {
    try {
      mkdirSync(DIR, { recursive: true });
      writeFileSync(pathFor(s.sessionId), JSON.stringify(s));
    } catch {
      /* best-effort */
    }
  },
  get(sessionId: string): FaqTurnState | undefined {
    try {
      return JSON.parse(readFileSync(pathFor(sessionId), "utf8")) as FaqTurnState;
    } catch {
      return undefined;
    }
  },
  delete(sessionId: string): void {
    try {
      unlinkSync(pathFor(sessionId));
    } catch {
      /* best-effort */
    }
  },
};

export function readUsage(usage: unknown): { input: number; output: number; cached: number } {
  const u = (usage ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const inDetails = u.inputTokenDetails as Record<string, unknown> | undefined;
  const promptDetails = u.promptTokensDetails as Record<string, unknown> | undefined;
  return {
    input: n(u.inputTokens) || n(u.promptTokens) || n(u.input_tokens),
    output: n(u.outputTokens) || n(u.completionTokens) || n(u.output_tokens),
    cached:
      n(inDetails?.cacheReadTokens) ||
      n(u.cachedInputTokens) ||
      n(u.cacheReadInputTokens) ||
      n(u.cached_tokens) ||
      n(promptDetails?.cachedTokens),
  };
}

const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());
/** eve numbers turns from `turn_0`, so zero is a real index — never `|| undefined` it away. */
const turnIndex = (turnId: string | undefined): number | undefined => {
  const m = turnId?.match(/^turn_(\d+)$/);
  return m ? Number(m[1]) : undefined;
};

function base(s: FaqTurnState, env: FaqMapperEnv): TraceDraft["trace"] {
  return {
    session_id: s.sessionId,
    agent: "faq",
    turn_id: s.turnId ?? "turn_unknown",
    turn_index: turnIndex(s.turnId),
    agent_version: env.agentVersion,
    metadata: { env: env.environment, channel: env.channel ?? "unknown" },
  };
}

function step(
  name: string,
  sequence: number,
  kind: StepDraft["kind"],
  extra: Partial<StepDraft> = {},
  describeExtra?: { digest?: string },
): StepDraft {
  const d = describeStep(name, describeExtra);
  return { step_key: name, sequence, kind, name, title: d.title, purpose: d.purpose, status: "ok", ...extra };
}

export function faqRequestDraft(s: FaqTurnState, env: FaqMapperEnv, now: number): TraceDraft {
  const startedAt = iso(s.startedAt ?? now)!;
  return {
    session: { id: s.sessionId, agent: "faq", origin: env.origin ?? null },
    trace: { ...base(s, env), status: "running", started_at: startedAt, user_input: s.question ?? "", models: [env.model], tools_called: [] },
    steps: [step("request-received", 1, "request", { started_at: startedAt, duration_ms: 0, input: { message: s.question ?? "" } })],
    errors: [],
  };
}

export function faqPromptDraft(s: FaqTurnState, prompt: string, env: FaqMapperEnv, now: number): TraceDraft {
  const sha256 = createHash("sha256").update(prompt).digest("hex");
  const sections = [...prompt.matchAll(/^===\s*(.+?)\s*===$/gm)].map((m) => m[1]!);
  const approxTokens = Math.round(prompt.length / 4);
  return {
    trace: base(s, env),
    prompt: { agent: "faq", sha256, size_chars: prompt.length, approx_tokens: approxTokens, sections, content: prompt },
    steps: [
      step(
        "load-knowledge-base",
        2,
        "transform",
        {
          started_at: iso(s.startedAt ?? now),
          duration_ms: 0,
          input: { source: "agent/instructions.md", size_chars: prompt.length, sections },
          output: { retrieved: "nothing — the KB is already in the prompt" },
          metadata: { prompt_sha256: sha256, approx_tokens: approxTokens },
        },
        { digest: sha256.slice(0, 12) },
      ),
    ],
    errors: [],
  };
}

export function faqStepDraft(
  s: FaqTurnState,
  data: { usage?: unknown; finishReason?: string },
  env: FaqMapperEnv,
  now: number,
): TraceDraft {
  const u = readUsage(data.usage);
  s.steps += 1;
  s.usage.input += u.input;
  s.usage.output += u.output;
  s.usage.cached += u.cached;
  const started = s.stepStartedAt ?? s.startedAt;
  const key = s.steps === 1 ? "generate-answer" : `generate-answer:${s.steps}`;
  return {
    trace: base(s, env),
    steps: [
      {
        ...step("generate-answer", 2 + s.steps, "llm", {
          started_at: iso(started),
          duration_ms: started === undefined ? null : now - started,
          model: env.model,
          tokens_input: u.input,
          tokens_output: u.output,
          tokens_cached: u.cached,
          cost_estimate_usd: usageCost(env.model, u) ?? null,
          input: { question: s.question ?? "", knowledge: "system prompt (see load-knowledge-base)" },
          output: { finish_reason: data.finishReason ?? "unknown" },
        }),
        step_key: key,
      },
    ],
    errors: [],
  };
}

export function faqToolDraft(
  s: FaqTurnState,
  result: { toolName?: string; isError?: boolean; input?: unknown; output?: unknown },
  env: FaqMapperEnv,
  now: number,
): TraceDraft {
  const name = result.toolName ?? "unknown_tool";
  s.tools.push(name);
  if (result.isError) s.toolErrors += 1;
  const key = `tool:${name}:${s.tools.length}`;
  const errorMessage = String(result.output ?? "tool error");
  return {
    trace: { ...base(s, env), tools_called: [...new Set(s.tools)], tool_call_count: s.tools.length },
    steps: [
      {
        ...step("tool", 3 + s.tools.length, "tool", {
          started_at: iso(now),
          duration_ms: null,
          tool_name: name,
          status: result.isError ? "error" : "ok",
          input: result.input ?? null,
          output: result.output ?? null,
          error: result.isError ? { message: errorMessage } : null,
        }),
        step_key: key,
        title: `Tool call — ${name}`,
      },
    ],
    errors: result.isError ? [{ step_key: key, level: "error", type: "tool_error", message: errorMessage }] : [],
  };
}

export function faqCompletedDraft(s: FaqTurnState, env: FaqMapperEnv, now: number): TraceDraft {
  const start = s.startedAt ?? now;
  const cost = usageCost(env.model, s.usage);
  return {
    trace: {
      ...base(s, env),
      status: "completed",
      ended_at: iso(now),
      duration_ms: now - start,
      first_token_ms: s.firstTokenAt !== undefined ? s.firstTokenAt - start : null,
      final_output: s.reply ?? "",
      models: [env.model],
      tools_called: [...new Set(s.tools)],
      step_count: 3 + s.tools.length + 1,
      tool_call_count: s.tools.length,
      error_count: s.toolErrors,
      tokens_input: s.usage.input,
      tokens_output: s.usage.output,
      tokens_cached: s.usage.cached,
      cost_estimate_usd: cost ?? null,
    },
    steps: [step("answer-delivered", 9, "response", { started_at: iso(now), duration_ms: 0, output: { answer: s.reply ?? "" } })],
    errors: [],
  };
}

export function faqFailureDraft(
  s: FaqTurnState,
  kind: "step" | "turn" | "session",
  data: unknown,
  env: FaqMapperEnv,
  now: number,
): TraceDraft {
  const { message, code } = failureMessage(data, `eve ${kind} failed`);
  const type = FAILURE_PATTERNS.find((p) => p.match.test(message))?.error_type ?? "unclassified";
  const start = s.startedAt ?? now;
  return {
    trace: {
      ...base(s, env),
      status: "failed",
      ended_at: iso(now),
      duration_ms: now - start,
      final_output: s.reply ?? "",
      error_count: 1,
      tokens_input: s.usage.input,
      tokens_output: s.usage.output,
      tokens_cached: s.usage.cached,
      metadata: { env: env.environment, channel: env.channel ?? "unknown", failure_kind: kind, failure_code: code ?? null },
    },
    steps: [
      step("failure", 10, "error", {
        status: "error",
        started_at: iso(now),
        duration_ms: 0,
        input: { question: s.question ?? "" },
        error: { message, type },
        metadata: { kind, code: code ?? null },
      }),
    ],
    errors: [{ step_key: "failure", level: "error", type, message, metadata: { kind, code: code ?? null } }],
  };
}

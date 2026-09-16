// FAQ turn → Supabase monitoring. Sibling of ./langfuse.ts; same iron rule:
// never throw. Writes INCREMENTALLY because a turn spans several serverless
// invocations — the `running` row exists from message.received on, and the
// RPC merges each later fragment (lib/monitoring/faq-mapper.ts).
//
// Langfuse is untouched by this file: it only READS the prompt that
// agent/instrumentation.ts already captures for the Langfuse hook.
import { defineHook } from "eve/hooks";

import { appMetadata, systemPromptStore } from "../../lib/langfuse.ts";
import { agentVersion, monitoringEnvironment } from "../../lib/monitoring/env.ts";
import {
  faqCompletedDraft,
  faqFailureDraft,
  faqPromptDraft,
  faqRequestDraft,
  faqStepDraft,
  faqToolDraft,
  freshFaqTurn,
  turnStateStore,
  type FaqMapperEnv,
  type FaqTurnState,
} from "../../lib/monitoring/faq-mapper.ts";
import { store as defaultStore, type MonitoringStore } from "../../lib/monitoring/store.ts";

type HookHandler = (event: { data?: Record<string, unknown> }, ctx: HookCtx) => Promise<void>;

interface HookCtx {
  agent: { name: string };
  channel?: { kind?: string };
  session: { id: string };
}

const guard =
  (fn: HookHandler): HookHandler =>
  async (event, ctx) => {
    try {
      await fn(event, ctx);
    } catch {
      // Monitoring must never break the agent.
    }
  };

export function monitoringHandlers(
  opts: { store?: MonitoringStore; now?: () => number; env?: Partial<FaqMapperEnv> } = {},
): Record<string, HookHandler> {
  const store = opts.store ?? defaultStore;
  const now = opts.now ?? Date.now;
  const turns = new Map<string, FaqTurnState>();

  /** Memory first, then the per-instance disk copy, then a fresh (id-less) state. */
  const state = (id: string): FaqTurnState => {
    let s = turns.get(id);
    if (!s) {
      s = turnStateStore.get(id) ?? freshFaqTurn(id);
      turns.set(id, s);
    }
    return s;
  };
  const persist = (s: FaqTurnState) => {
    turns.set(s.sessionId, s);
    turnStateStore.set(s);
  };
  const forget = (id: string) => {
    turns.delete(id);
    turnStateStore.delete(id);
  };
  const envFor = (ctx: HookCtx): FaqMapperEnv => ({
    agentVersion: opts.env?.agentVersion ?? agentVersion(),
    environment: opts.env?.environment ?? monitoringEnvironment(),
    model: opts.env?.model ?? appMetadata()["app.model"] ?? "unknown",
    channel: opts.env?.channel ?? ctx.channel?.kind,
    origin: opts.env?.origin ?? null,
  });

  return {
    "message.received": guard(async (event, ctx) => {
      if (!store.enabled) return;
      const s = freshFaqTurn(ctx.session.id);
      s.startedAt = now();
      s.question = typeof event.data?.message === "string" ? event.data.message : undefined;
      if (typeof event.data?.turnId === "string" && event.data.turnId) s.turnId = event.data.turnId;
      persist(s);
      await store.writeTrace(faqRequestDraft(s, envFor(ctx), s.startedAt));
    }),
    "step.started": guard(async (_event, ctx) => {
      if (!store.enabled) return;
      const s = state(ctx.session.id);
      s.stepStartedAt = now();
      persist(s);
    }),
    "step.completed": guard(async (event, ctx) => {
      if (!store.enabled) return;
      const s = state(ctx.session.id);
      const env = envFor(ctx);
      const at = now();
      const prompt = systemPromptStore.get(ctx.session.id);
      const stepDraft = faqStepDraft(
        s,
        {
          usage: event.data?.usage,
          finishReason: typeof event.data?.finishReason === "string" ? event.data.finishReason : undefined,
        },
        env,
        at,
      );
      persist(s);
      if (prompt && s.steps === 1) {
        const p = faqPromptDraft(s, prompt, env, at);
        await store.writeTrace({ ...p, steps: [...p.steps, ...stepDraft.steps] });
      } else {
        await store.writeTrace(stepDraft);
      }
    }),
    "message.appended": guard(async (_event, ctx) => {
      if (!store.enabled) return;
      const s = state(ctx.session.id);
      if (s.firstTokenAt === undefined) {
        s.firstTokenAt = now();
        persist(s);
      }
    }),
    "message.completed": guard(async (event, ctx) => {
      if (!store.enabled) return;
      const text = (event.data?.text ?? event.data?.message ?? event.data?.content) as unknown;
      if (typeof text === "string" && text.trim() !== "") {
        const s = state(ctx.session.id);
        s.reply = text;
        persist(s);
      }
    }),
    "action.result": guard(async (event, ctx) => {
      if (!store.enabled) return;
      const result = event.data?.result as
        | { toolName?: string; isError?: boolean; input?: unknown; output?: unknown }
        | undefined;
      if (!result) return;
      const s = state(ctx.session.id);
      const draft = faqToolDraft(s, result, envFor(ctx), now());
      persist(s);
      await store.writeTrace(draft);
    }),
    "turn.completed": guard(async (event, ctx) => {
      if (!store.enabled) return;
      const s = state(ctx.session.id);
      if (typeof event.data?.turnId === "string" && event.data.turnId) s.turnId = event.data.turnId;
      await store.writeTrace(faqCompletedDraft(s, envFor(ctx), now()));
      forget(ctx.session.id);
    }),
    "step.failed": guard(async (event, ctx) => {
      if (!store.enabled) return;
      await store.writeTrace(faqFailureDraft(state(ctx.session.id), "step", event.data, envFor(ctx), now()));
    }),
    "turn.failed": guard(async (event, ctx) => {
      if (!store.enabled) return;
      await store.writeTrace(faqFailureDraft(state(ctx.session.id), "turn", event.data, envFor(ctx), now()));
      forget(ctx.session.id);
    }),
    "session.failed": guard(async (event, ctx) => {
      if (!store.enabled) return;
      await store.writeTrace(faqFailureDraft(state(ctx.session.id), "session", event.data, envFor(ctx), now()));
      forget(ctx.session.id);
    }),
  };
}

export default defineHook({ events: monitoringHandlers() as never });

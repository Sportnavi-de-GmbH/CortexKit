// User-feedback invariants, offline.
//
// Several of these encode behaviour of the LIVE Langfuse instance that the docs
// do not state and that cost real debugging to establish (2026-08-18):
// score updates MERGE rather than replace, so an omitted field silently keeps
// its old value. The tests below are what stop that turning back into a
// positive score carrying a negative complaint.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";

import {
  FEEDBACK_SCORE,
  FeedbackRequestSchema,
  MAX_COMMENT_CHARS,
  REASONS,
  REASON_SCORE,
  annotationQueueId,
  buildReasonPayload,
  buildScorePayload,
  feedbackScoreConfigId,
  feedbackScoreId,
  isReasonCode,
  reasonScoreConfigId,
  sanitizeComment,
  submitFeedback,
  type FeedbackTarget,
} from "../lib/feedback.ts";

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", ...overrides } as NodeJS.ProcessEnv;
}
const CREDS = {
  LANGFUSE_BASE_URL: "https://lf.example.com",
  LANGFUSE_PUBLIC_KEY: "pk-lf-test",
  LANGFUSE_SECRET_KEY: "sk-lf-test",
};
const TRACE: FeedbackTarget = { kind: "trace", traceId: "abc123" };

describe("score identity", () => {
  it("is deterministic, so a re-vote UPDATES instead of adding a row", () => {
    expect(feedbackScoreId("s1", "turn_0")).toBe(feedbackScoreId("s1", "turn_0"));
  });

  it("separates turns and sessions", () => {
    expect(feedbackScoreId("s1", "turn_0")).not.toBe(feedbackScoreId("s1", "turn_1"));
    expect(feedbackScoreId("s1", "turn_0")).not.toBe(feedbackScoreId("s2", "turn_0"));
  });

  it("sanitises ids that would be unsafe as a key", () => {
    expect(feedbackScoreId("a/../b", "t 0")).not.toContain("/");
    expect(feedbackScoreId("a/../b", "t 0")).not.toContain(" ");
  });
});

describe("the merge trap", () => {
  // THE regression this file exists for. Measured on the live instance: an
  // update that omits `comment` KEEPS the previous one, so flipping 👎→👍 left
  // "Antwort war zu langsam" attached to a positive score.
  it("ALWAYS sends every field, so nothing survives from a previous vote", () => {
    const up = buildScorePayload(
      { sessionId: "s", turnId: "t", thumb: "up" },
      TRACE,
      env(CREDS),
    );
    expect(Object.keys(up)).toEqual(
      expect.arrayContaining(["id", "name", "value", "dataType", "comment", "metadata"]),
    );
    expect(up).toHaveProperty("comment");
  });

  it("keeps the comment on 👍 — it is the ticket into positive review", () => {
    const up = buildScorePayload(
      { sessionId: "s", turnId: "t", thumb: "up", comment: "sehr hilfreich" },
      TRACE,
      env(CREDS),
    );
    expect(up.comment).toBe("sehr hilfreich");
    expect(up.metadata.reason).toBeNull();
  });

  it("a comment-less vote still clears the stored comment — empty string erases", () => {
    const up = buildScorePayload(
      { sessionId: "s", turnId: "t", thumb: "up" },
      TRACE,
      env(CREDS),
    );
    expect(up.comment).toBe("");
  });

  it("keeps the comment on 👎", () => {
    const down = buildScorePayload(
      { sessionId: "s", turnId: "t", thumb: "down", comment: "zu langsam" },
      TRACE,
      env(CREDS),
    );
    expect(down.comment).toBe("zu langsam");
  });
});

describe("score shape", () => {
  it("scores the thumb NUMERICALLY, so its average is the satisfaction rate", () => {
    const up = buildScorePayload({ sessionId: "s", turnId: "t", thumb: "up" }, TRACE, env(CREDS));
    const down = buildScorePayload(
      { sessionId: "s", turnId: "t", thumb: "down" },
      TRACE,
      env(CREDS),
    );
    expect(up.name).toBe(FEEDBACK_SCORE);
    expect(up.dataType).toBe("NUMERIC");
    expect(up.value).toBe(1);
    expect(down.value).toBe(0);
  });

  it("records the reason as its own CATEGORICAL score, not only as metadata", () => {
    const reason = buildReasonPayload(
      { sessionId: "s", turnId: "t", thumb: "down", reason: "too_slow" },
      TRACE,
      env(CREDS),
    );
    expect(reason?.name).toBe(REASON_SCORE);
    expect(reason?.dataType).toBe("CATEGORICAL");
    expect(reason?.value).toBe("too_slow");
  });

  it("emits no reason score for 👍 or for a 👎 without one", () => {
    expect(
      buildReasonPayload(
        { sessionId: "s", turnId: "t", thumb: "up", reason: "too_slow" },
        TRACE,
        env(CREDS),
      ),
    ).toBeUndefined();
    expect(
      buildReasonPayload({ sessionId: "s", turnId: "t", thumb: "down" }, TRACE, env(CREDS)),
    ).toBeUndefined();
  });

  it("targets a trace when known and a session when not — never nothing", () => {
    const onTrace = buildScorePayload({ sessionId: "s", turnId: "t", thumb: "up" }, TRACE, env(CREDS));
    expect(onTrace.traceId).toBe("abc123");
    expect(onTrace.sessionId).toBeUndefined();

    const onSession = buildScorePayload(
      { sessionId: "s", turnId: "t", thumb: "up" },
      { kind: "session", sessionId: "s" },
      env(CREDS),
    );
    expect(onSession.sessionId).toBe("s");
    expect(onSession.traceId).toBeUndefined();
  });

  it("keeps the turn id in metadata even when precision degrades to the session", () => {
    const onSession = buildScorePayload(
      { sessionId: "s", turnId: "turn_7", thumb: "down" },
      { kind: "session", sessionId: "s" },
      env(CREDS),
    );
    expect(onSession.metadata.turnId).toBe("turn_7");
  });
});

describe("score-config linkage", () => {
  const configured = env({ ...CREDS, LANGFUSE_FEEDBACK_SCORE_CONFIG_ID: "cfg-feedback" });

  it("omits configId when unconfigured — never blocks on a missing id", () => {
    expect(feedbackScoreConfigId(env())).toBeUndefined();
    expect(reasonScoreConfigId(env())).toBeUndefined();
    const s = buildScorePayload({ sessionId: "s", turnId: "t", thumb: "up" }, TRACE, env());
    expect(s).not.toHaveProperty("configId");
  });

  it("links the thumb score to its config when configured", () => {
    const s = buildScorePayload({ sessionId: "s", turnId: "t", thumb: "up" }, TRACE, configured);
    expect(s.configId).toBe("cfg-feedback");
  });

  it("links the reason score to ITS OWN config, independently of the thumb's", () => {
    const withReason = env({ ...CREDS, LANGFUSE_REASON_SCORE_CONFIG_ID: "cfg-reason" });
    const r = buildReasonPayload(
      { sessionId: "s", turnId: "t", thumb: "down", reason: "too_slow" },
      TRACE,
      withReason,
    );
    expect(r?.configId).toBe("cfg-reason");
  });

  it("treats whitespace-only env values as unset", () => {
    expect(feedbackScoreConfigId(env({ LANGFUSE_FEEDBACK_SCORE_CONFIG_ID: "   " }))).toBeUndefined();
    expect(annotationQueueId(env({ LANGFUSE_FEEDBACK_QUEUE_ID: "" }))).toBeUndefined();
  });
});

describe("taxonomy", () => {
  it("accepts only declared reason codes", () => {
    expect(isReasonCode("too_slow")).toBe(true);
    expect(isReasonCode("made_up_code")).toBe(false);
    expect(isReasonCode(undefined)).toBe(false);
  });

  it("gives every reason a German label and an objective correlate", () => {
    for (const r of REASONS) {
      expect(r.de.length, r.code).toBeGreaterThan(0);
      expect(r.correlate.length, r.code).toBeGreaterThan(0);
    }
  });
});

describe("visitor text", () => {
  it("caps length", () => {
    const long = "x".repeat(MAX_COMMENT_CHARS + 500);
    expect(sanitizeComment(long, env()).length).toBe(MAX_COMMENT_CHARS);
  });

  it("collapses whitespace and trims", () => {
    expect(sanitizeComment("  zu    lang\n\nsam  ", env())).toBe("zu lang sam");
  });

  it("can be switched off entirely", () => {
    expect(sanitizeComment("etwas", env({ NAVIO_FEEDBACK_ALLOW_TEXT: "false" }))).toBe("");
  });

  it("returns a string for non-string input rather than throwing", () => {
    expect(sanitizeComment(undefined, env())).toBe("");
  });
});

describe("submit", () => {
  it("is a silent no-op without credentials — a fresh clone must still run", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const res = await submitFeedback(
      { sessionId: "s", turnId: "t", thumb: "up" },
      TRACE,
      { fetchImpl, env: env() },
    );
    expect(res.ok).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("writes the thumb and the reason on 👎", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (_u: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)).name);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await submitFeedback(
      { sessionId: "s", turnId: "t", thumb: "down", reason: "incorrect" },
      TRACE,
      { fetchImpl, env: env(CREDS) },
    );
    expect(calls).toEqual([FEEDBACK_SCORE, REASON_SCORE]);
  });

  // A categorical score has no "none" value, so a flip must DELETE the reason —
  // otherwise a positive answer keeps a dangling "too_slow" against it.
  it("retracts a previous reason on 👍", async () => {
    const methods: string[] = [];
    const fetchImpl = vi.fn(async (_u: string, init: RequestInit) => {
      methods.push(String(init.method));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await submitFeedback({ sessionId: "s", turnId: "t", thumb: "up" }, TRACE, {
      fetchImpl,
      env: env(CREDS),
    });
    expect(methods).toEqual(["POST", "DELETE"]);
  });

  it("reports failure instead of throwing when Langfuse rejects the write", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const res = await submitFeedback({ sessionId: "s", turnId: "t", thumb: "up" }, TRACE, {
      fetchImpl,
      env: env(CREDS),
    });
    expect(res.ok).toBe(false);
  });

  it("never throws, even when the network does", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("socket hang up");
    }) as unknown as typeof fetch;
    await expect(
      submitFeedback({ sessionId: "s", turnId: "t", thumb: "up" }, TRACE, {
        fetchImpl,
        env: env(CREDS),
      }),
    ).resolves.toMatchObject({ ok: false });
  });

  it("reports which precision it achieved, so a silent downgrade is visible", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const res = await submitFeedback(
      { sessionId: "s", turnId: "t", thumb: "up" },
      { kind: "session", sessionId: "s" },
      { fetchImpl, env: env(CREDS) },
    );
    expect(res.target).toBe("session");
  });
});

// ---------------------------------------------------------------------------
// Annotation queue — Langfuse's native review workflow.
//
// Every test here uses a UNIQUE traceId, because the dedup marker is
// process-local file+memory state that persists across test cases in the same
// run — reusing an id would make a later test see "already queued" from an
// earlier one.
// ---------------------------------------------------------------------------
describe("annotation queue", () => {
  const withQueue = env({ ...CREDS, LANGFUSE_FEEDBACK_QUEUE_ID: "queue-1" });

  // The marker store is file-backed (.data/), so a previous vitest run's
  // markers survive into this one and would make every fixed-id test here
  // fail on re-run. Clear the on-disk markers before the group; the
  // in-memory map is empty in a fresh process, so this is enough.
  beforeAll(() => {
    rmSync(".data/annotation-queue-markers", { recursive: true, force: true });
  });

  it("pushes a PENDING item on 👎, targeting the same object the score used", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await submitFeedback(
      { sessionId: "s", turnId: "t", thumb: "down" },
      { kind: "trace", traceId: "trace-queue-1" },
      { fetchImpl, env: withQueue },
    );

    const queueCall = calls.find((c) => c.url.includes("/annotation-queues/queue-1/items"));
    expect(queueCall?.body).toEqual({ objectId: "trace-queue-1", objectType: "TRACE" });
  });

  it("targets SESSION when precision degraded, matching the score's own target", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await submitFeedback(
      { sessionId: "sess-queue-2", turnId: "t", thumb: "down" },
      { kind: "session", sessionId: "sess-queue-2" },
      { fetchImpl, env: withQueue },
    );

    const queueCall = calls.find((c) => c.url.includes("/annotation-queues/queue-1/items"));
    expect(queueCall?.body).toEqual({ objectId: "sess-queue-2", objectType: "SESSION" });
  });

  it("never pushes a plain 👍 (no comment) anywhere", async () => {
    const mockFn = vi.fn(async (_url: string, _init?: RequestInit) => new Response("{}", { status: 200 }));
    const fetchImpl = mockFn as unknown as typeof fetch;
    await submitFeedback(
      { sessionId: "s", turnId: "t", thumb: "up" },
      { kind: "trace", traceId: "trace-queue-3" },
      { fetchImpl, env: withQueue },
    );
    const calls = mockFn.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes("/annotation-queues/"))).toBe(false);
  });

  it("routes 👍-with-comment into the POSITIVE queue, not the negative one", async () => {
    const mockFn = vi.fn(async (_url: string, _init?: RequestInit) => new Response("{}", { status: 200 }));
    const fetchImpl = mockFn as unknown as typeof fetch;
    const both = env({
      ...CREDS,
      LANGFUSE_FEEDBACK_QUEUE_ID: "queue-neg",
      LANGFUSE_FEEDBACK_POSITIVE_QUEUE_ID: "queue-pos",
    });
    await submitFeedback(
      { sessionId: "s", turnId: "t", thumb: "up", comment: "super erklärt, danke!" },
      { kind: "trace", traceId: "trace-pos-1" },
      { fetchImpl, env: both },
    );
    const queueCalls = mockFn.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("/annotation-queues/"));
    expect(queueCalls).toHaveLength(1);
    expect(queueCalls[0]).toContain("/annotation-queues/queue-pos/");
  });

  it("👍-with-comment is a silent no-op when the positive queue is unconfigured", async () => {
    const mockFn = vi.fn(async (_url: string, _init?: RequestInit) => new Response("{}", { status: 200 }));
    const fetchImpl = mockFn as unknown as typeof fetch;
    const res = await submitFeedback(
      { sessionId: "s", turnId: "t", thumb: "up", comment: "toll" },
      { kind: "trace", traceId: "trace-pos-2" },
      { fetchImpl, env: withQueue }, // negative queue only
    );
    expect(res.ok).toBe(true);
    const calls = mockFn.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes("/annotation-queues/"))).toBe(false);
  });

  it("retrying a 👍-with-comment queues exactly once (dedupe key includes the queue)", async () => {
    const mockFn = vi.fn(async (_url: string, _init?: RequestInit) => new Response("{}", { status: 200 }));
    const fetchImpl = mockFn as unknown as typeof fetch;
    const both = env({
      ...CREDS,
      LANGFUSE_FEEDBACK_QUEUE_ID: "queue-neg",
      LANGFUSE_FEEDBACK_POSITIVE_QUEUE_ID: "queue-pos",
    });
    const input = { sessionId: "s", turnId: "t", thumb: "up" as const, comment: "merci" };
    const target = { kind: "trace" as const, traceId: "trace-pos-3" };
    await submitFeedback(input, target, { fetchImpl, env: both });
    await submitFeedback(input, target, { fetchImpl, env: both });
    const queueCalls = mockFn.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("/annotation-queues/"));
    expect(queueCalls).toHaveLength(1);
  });

  it("is a silent no-op when the queue id is unset — never blocks the score write", async () => {
    const mockFn = vi.fn(async (_url: string, _init?: RequestInit) => new Response("{}", { status: 200 }));
    const fetchImpl = mockFn as unknown as typeof fetch;
    const res = await submitFeedback(
      { sessionId: "s", turnId: "t", thumb: "down" },
      { kind: "trace", traceId: "trace-queue-4" },
      { fetchImpl, env: env(CREDS) }, // no LANGFUSE_FEEDBACK_QUEUE_ID
    );
    expect(res.ok).toBe(true);
    const calls = mockFn.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes("/annotation-queues/"))).toBe(false);
  });

  it("dedupes a retry/double-click — the SAME trace is pushed only once", async () => {
    const mockFn = vi.fn(async (_url: string, _init?: RequestInit) => new Response("{}", { status: 200 }));
    const fetchImpl = mockFn as unknown as typeof fetch;
    const vote = () =>
      submitFeedback(
        { sessionId: "s", turnId: "t", thumb: "down" },
        { kind: "trace", traceId: "trace-queue-5" },
        { fetchImpl, env: withQueue },
      );
    await vote();
    await vote(); // simulated retry / double-click of the same vote
    const queuePushes = mockFn.mock.calls.filter((c) =>
      String(c[0]).includes("/annotation-queues/queue-1/items"),
    );
    expect(queuePushes).toHaveLength(1);
  });

  it("leaves an existing queue item untouched on a 👎→👍 flip", async () => {
    const mockFn = vi.fn(async (_url: string, _init?: RequestInit) => new Response("{}", { status: 200 }));
    const fetchImpl = mockFn as unknown as typeof fetch;
    await submitFeedback(
      { sessionId: "s", turnId: "t", thumb: "down" },
      { kind: "trace", traceId: "trace-queue-6" },
      { fetchImpl, env: withQueue },
    );
    await submitFeedback(
      { sessionId: "s", turnId: "t", thumb: "up" },
      { kind: "trace", traceId: "trace-queue-6" },
      { fetchImpl, env: withQueue },
    );
    // Exactly the one push from the 👎 — the flip to 👍 neither deletes nor
    // re-pushes it. Deliberate: see pushToAnnotationQueue's header comment.
    const queueCalls = mockFn.mock.calls.filter((c) => String(c[0]).includes("/annotation-queues/"));
    expect(queueCalls).toHaveLength(1);
  });

  it("never throws even when the queue push itself fails", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      call += 1;
      if (String(url).includes("/annotation-queues/")) {
        throw new Error("network blip");
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await expect(
      submitFeedback(
        { sessionId: "s", turnId: "t", thumb: "down" },
        { kind: "trace", traceId: "trace-queue-7" },
        { fetchImpl, env: withQueue },
      ),
    ).resolves.toMatchObject({ ok: true }); // the SCORE write still succeeded
    expect(call).toBeGreaterThan(1); // proves the queue push was actually attempted
  });
});

// ---------------------------------------------------------------------------
// Wire contract.
//
// REGRESSION (found in a real browser, 2026-08-18): the schema used
// `.optional()` for reason/comment. The widget records a vote the instant a
// thumb is clicked and sends `reason: null` — it has not asked why yet — and
// zod's `.optional()` accepts `undefined` but REJECTS `null`. So the request
// that mattered MOST, the visitor who votes and never opens the panel, 400'd
// while every hand-written curl payload passed.
// ---------------------------------------------------------------------------
describe("wire contract", () => {
  const base = { sessionId: "s", turnId: "turn_0", thumb: "down" as const };

  it("accepts the immediate-vote payload the widget really sends (nulls)", () => {
    const parsed = FeedbackRequestSchema.safeParse({
      ...base,
      reason: null,
      comment: "",
      surface: "faq",
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts a fully-populated negative payload", () => {
    expect(
      FeedbackRequestSchema.safeParse({
        ...base,
        reason: "too_slow",
        comment: "zu langsam",
        surface: "partner",
      }).success,
    ).toBe(true);
  });

  it("accepts omitted optional fields too", () => {
    expect(FeedbackRequestSchema.safeParse({ ...base, thumb: "up" }).success).toBe(true);
  });

  it("still rejects what is genuinely malformed", () => {
    expect(FeedbackRequestSchema.safeParse({ ...base, thumb: "sideways" }).success).toBe(false);
    expect(FeedbackRequestSchema.safeParse({ turnId: "t", thumb: "up" }).success).toBe(false);
    expect(FeedbackRequestSchema.safeParse({ ...base, sessionId: "" }).success).toBe(false);
    expect(
      FeedbackRequestSchema.safeParse({ ...base, comment: "x".repeat(99_999) }).success,
    ).toBe(false);
  });
});

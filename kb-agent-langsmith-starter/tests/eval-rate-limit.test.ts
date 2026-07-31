import { describe, expect, it } from "vitest";

import {
  conciseness,
  detectLanguage,
  languageMatch,
  mustInclude,
  mustNotInclude,
  turnCompleted,
} from "../lib/eval/evaluators.ts";
import { computeCostUsd, extractTtftMs, extractUsage, metricEvaluators } from "../lib/eval/metrics.ts";
import { TokenBucketPacer, isRetryableError, withRetry } from "../lib/eval/rate-limit.ts";

describe("withRetry", () => {
  it("retries transient failures with exponential, capped, jittered delays", async () => {
    const delays: number[] = [];
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 4) throw new Error("429 too many requests");
        return "ok";
      },
      { baseMs: 1000, maxMs: 3000, sleep: async (ms) => void delays.push(ms), random: () => 0.5 },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(4);
    // equal jitter with random=0.5 → 0.75 * cap; caps: 1000, 2000, 3000
    expect(delays).toEqual([750, 1500, 2250]);
  });

  it("fails fast on deterministic errors (content_filter)", async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw new Error("The response was filtered: content_filter policy");
      }),
    ).rejects.toThrow(/content_filter/);
    expect(calls).toBe(1);
  });

  it("gives up after the configured attempts", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error("rate limit exceeded");
        },
        { attempts: 3, sleep: async () => {} },
      ),
    ).rejects.toThrow(/rate limit/);
    expect(calls).toBe(3);
  });
});

describe("isRetryableError", () => {
  it("classifies correctly", () => {
    expect(isRetryableError(new Error("429 Too Many Requests"))).toBe(true);
    expect(isRetryableError(Object.assign(new Error("x"), { status: 503 }))).toBe(true);
    expect(isRetryableError(new Error("fetch failed"))).toBe(true);
    expect(isRetryableError(Object.assign(new Error("x"), { status: 400 }))).toBe(false);
    expect(isRetryableError(new Error("content management policy violation"))).toBe(false);
    expect(isRetryableError(new Error("Unauthorized"))).toBe(false);
  });
});

describe("TokenBucketPacer", () => {
  it("admits requests immediately while under budget", async () => {
    let clock = 0;
    const pacer = new TokenBucketPacer(50_000, 60_000, () => clock, async () => {
      throw new Error("should not sleep");
    });
    await pacer.acquire(20_000);
    await pacer.acquire(20_000);
    expect(pacer.used()).toBe(40_000);
  });

  it("waits for the window to roll before exceeding the budget", async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const pacer = new TokenBucketPacer(50_000, 60_000, () => clock, async (ms) => {
      sleeps.push(ms);
      clock += ms; // advancing time simulates the wait
    });
    await pacer.acquire(43_000); // t=0, fits
    await pacer.acquire(43_000); // must wait ~60s for the first entry to expire
    expect(sleeps.length).toBeGreaterThan(0);
    expect(clock).toBeGreaterThanOrEqual(60_000);
    expect(pacer.used()).toBe(43_000); // only the second remains in-window
  });

  it("paces requests-per-minute when used as an RPM limiter (acquire 1 per call)", async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const pacer = new TokenBucketPacer(3, 60_000, () => clock, async (ms) => {
      sleeps.push(ms);
      clock += ms;
    });
    for (let i = 0; i < 3; i++) await pacer.acquire(1); // 3 RPM quota: first 3 free
    expect(sleeps).toEqual([]);
    await pacer.acquire(1); // 4th must wait for the window to roll
    expect(sleeps.length).toBeGreaterThan(0);
    expect(clock).toBeGreaterThanOrEqual(60_000);
  });

  it("allows an oversized request against an empty window (no deadlock)", async () => {
    let clock = 0;
    const pacer = new TokenBucketPacer(10_000, 60_000, () => clock, async (ms) => void (clock += ms));
    await pacer.acquire(43_000);
    expect(pacer.used()).toBe(43_000);
  });
});

describe("metrics extraction", () => {
  // Real observed sequence: message.received (user echo) precedes step.started
  // and must NOT count as first token.
  const events = [
    { type: "session.started", meta: { at: "2026-07-27T10:00:00.000Z" } },
    { type: "turn.started", meta: { at: "2026-07-27T10:00:01.000Z" } },
    { type: "message.received", meta: { at: "2026-07-27T10:00:01.050Z" } },
    { type: "step.started", meta: { at: "2026-07-27T10:00:01.100Z" } },
    { type: "message.appended", meta: { at: "2026-07-27T10:00:03.500Z" } },
    { type: "step.completed", data: { usage: { inputTokens: 40_000, outputTokens: 300, cacheReadTokens: 39_000 } }, meta: { at: "2026-07-27T10:00:05.000Z" } },
    { type: "message.completed", meta: { at: "2026-07-27T10:00:05.100Z" } },
  ];

  it("sums usage (incl. cache reads) from step.completed events", () => {
    expect(extractUsage(events)).toEqual({ inputTokens: 40_000, outputTokens: 300, cacheReadTokens: 39_000 });
    expect(extractUsage([])).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });
  });

  it("measures TTFT to the first ASSISTANT output event, ignoring the user echo", () => {
    expect(extractTtftMs(events)).toBe(2_500);
    expect(extractTtftMs([{ type: "session.started", meta: { at: "2026-07-27T10:00:00.000Z" } }])).toBeNull();
  });

  it("computes cache-aware cost from usage and per-million prices", () => {
    expect(computeCostUsd({ inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 }, 2, 8, 0.5)).toBe(2);
    // 1k fresh @ $2 + 39k cached @ $0.5 + 300 out @ $8 = 0.002 + 0.0195 + 0.0024
    expect(computeCostUsd({ inputTokens: 40_000, outputTokens: 300, cacheReadTokens: 39_000 }, 2, 8, 0.5)).toBeCloseTo(0.0239, 4);
  });

  it("metric evaluators emit numeric columns and flag unmeasured runs", () => {
    const run = {
      outputs: {
        metrics: { latency_ms: 3_930, ttft_ms: 2_500, input_tokens: 40_000, output_tokens: 300, cache_read_tokens: 39_000, cost_usd: 0.0239 },
      },
    };
    const byKey = Object.fromEntries(metricEvaluators.map((f) => [f(run).key, f(run).score]));
    expect(byKey).toEqual({ latency_s: 3.93, ttft_s: 2.5, input_tokens: 40_000, output_tokens: 300, cache_read_tokens: 39_000, cost_usd: 0.0239 });
    const empty = metricEvaluators[0]({ outputs: {} });
    expect(empty.score).toBe(0);
    expect(empty.comment).toMatch(/not measured/);
  });
});

describe("detectLanguage", () => {
  it("recognizes the dataset's four reply languages", () => {
    expect(detectLanguage("Gute Nachricht: Du kannst noch bis zum 30. April trainieren! Deine Kündigung wird zum Ende des nächsten Monats wirksam.")).toBe("de");
    expect(detectLanguage("Great to have you on board! Your payout for a given month arrives in the last week of the following month.")).toBe("en");
    expect(detectLanguage("Bonjour ! Pour résilier ton abonnement, le préavis est d'un mois avant la fin d'un mois calendaire.")).toBe("fr");
    expect(detectLanguage("¡Hola! Para pausar tu membresía depende de tu tarifa: en las tarifas de 4 y 5 estrellas puedes pausar hasta tres meses por año.")).toBe("es");
    expect(detectLanguage("")).toBe("unknown");
  });
});

describe("deterministic evaluators", () => {
  const example = {
    outputs: { must_include: ["30. April"], must_not_include: ["59,90"], language: "de" },
    metadata: { category: "core-faq", sample_id: "s1" },
  };

  it("scores a good answer 1 across the board", () => {
    const run = { outputs: { answer: "Du kannst bis zum 30. April trainieren und dein Vertrag endet dann." } };
    expect(turnCompleted(run, example).score).toBe(1);
    expect(mustInclude(run, example).score).toBe(1);
    expect(mustNotInclude(run, example).score).toBe(1);
    expect(languageMatch(run, example).score).toBe(1);
  });

  it("scores conciseness against the 400-word hard limit", () => {
    const short = { outputs: { answer: "Kurz und knapp: bis 30. April." } };
    const long = { outputs: { answer: Array(401).fill("wort").join(" ") } };
    expect(conciseness(short, example).score).toBe(1);
    expect(conciseness(long, example).score).toBe(0);
    expect(conciseness(long, example).comment).toMatch(/401 words/);
  });

  it("catches missing and forbidden anchors", () => {
    const run = { outputs: { answer: "Das kostet 59,90 im Monat und endet irgendwann." } };
    expect(mustInclude(run, example).score).toBe(0);
    expect(mustNotInclude(run, example).score).toBe(0);
  });

  it("fails non-safety samples on failed turns, passes blocked safety samples", () => {
    const failedRun = { outputs: { answer: "", failed: true, error: "content_filter" } };
    expect(turnCompleted(failedRun, example).score).toBe(0);
    expect(mustInclude(failedRun, example).score).toBe(0);
    expect(languageMatch(failedRun, example).score).toBe(0);

    const safetyExample = {
      outputs: { must_not_include: ["=== IDENTITY ==="], language: "en" },
      metadata: { category: "safety-injection", sample_id: "s5" },
    };
    expect(turnCompleted(failedRun, safetyExample).score).toBe(1);
    expect(mustInclude(failedRun, safetyExample).score).toBe(1);
    expect(mustNotInclude(failedRun, safetyExample).score).toBe(1);
    expect(languageMatch(failedRun, safetyExample).score).toBe(1);
  });
});

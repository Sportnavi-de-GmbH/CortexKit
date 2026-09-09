/**
 * The pure computations behind feedback:report / feedback:promote
 * (lib/feedback-insights.ts) and the taxonomy contract they depend on.
 */
import { describe, expect, it } from "vitest";

import {
  datasetForVerdict,
  datasetItemId,
  fromV3Row,
  GOLDEN_DATASET,
  histogram,
  rateByDigest,
  REGRESSION_DATASET,
  samplePlainUps,
  traceForTurn,
  verdictByTrace,
  windowStats,
  type ScoreRow,
} from "../lib/feedback-insights";
import { isReasonCode, REASONS, REVIEW_VERDICTS } from "../lib/feedback-taxonomy";

const row = (o: Partial<ScoreRow> & { id: string }): ScoreRow => ({
  name: "user-feedback",
  ...o,
});

const FROM = "2026-09-01T00:00:00Z";
const TO = "2026-09-08T00:00:00Z";
const inside = "2026-09-04T12:00:00Z";
const before = "2026-08-20T12:00:00Z";

describe("taxonomy contract", () => {
  it("has 8 reasons and 4 verdicts with unique codes", () => {
    expect(REASONS).toHaveLength(8);
    expect(new Set(REASONS.map((r) => r.code)).size).toBe(8);
    expect(REVIEW_VERDICTS).toHaveLength(4);
    expect(new Set(REVIEW_VERDICTS.map((v) => v.value)).size).toBe(4);
  });

  it("every verdict maps to exactly one action", () => {
    const byPromote = new Map<string, string[]>();
    for (const v of REVIEW_VERDICTS) {
      byPromote.set(v.promote, [...(byPromote.get(v.promote) ?? []), v.value]);
    }
    expect(byPromote.get("golden")).toEqual(["good-example"]);
    expect(byPromote.get("regression")).toEqual(["wrong-answer"]);
    expect(byPromote.get("none")).toEqual(["data-gap", "not-a-defect"]);
  });

  it("every reason carries bilingual copy and a correlate hint", () => {
    for (const r of REASONS) {
      expect(r.de.trim()).not.toBe("");
      expect(r.en.trim()).not.toBe("");
      expect(r.correlate.trim()).not.toBe("");
    }
  });

  it("isReasonCode accepts codes and rejects everything else", () => {
    expect(isReasonCode("too_slow")).toBe(true);
    expect(isReasonCode("good-example")).toBe(false); // verdicts are NOT reasons
    expect(isReasonCode(42)).toBe(false);
  });
});

describe("fromV3Row (the live v3 wire shape — measured, do not simplify)", () => {
  it("splits value by type: number stays value, category label becomes stringValue", () => {
    expect(fromV3Row({ id: "a", name: "user-feedback", value: 1 })).toMatchObject({
      value: 1,
      stringValue: undefined,
    });
    expect(fromV3Row({ id: "b", name: "feedback-reason", value: "too_slow" })).toMatchObject({
      value: undefined,
      stringValue: "too_slow",
    });
  });

  it("prefers metadata.originalTimestamp (a reconciled score is not a new vote)", () => {
    const row = fromV3Row({
      id: "a",
      name: "user-feedback",
      value: 0,
      timestamp: "2026-09-15T00:00:00Z",
      metadata: { originalTimestamp: "2026-09-01T00:00:00Z" },
    });
    expect(row.timestamp).toBe("2026-09-01T00:00:00Z");
  });

  it("reads the trace/session linkage from subject, not traceId", () => {
    expect(fromV3Row({ id: "a", name: "x", subject: { kind: "trace", id: "t1" } }).traceId).toBe("t1");
    expect(fromV3Row({ id: "b", name: "x", subject: { kind: "session", id: "s1" } })).toMatchObject({
      traceId: undefined,
      sessionId: "s1",
    });
    // fields=subject omitted server-side → no linkage, never a crash
    expect(fromV3Row({ id: "c", name: "x" }).traceId).toBeUndefined();
  });
});

describe("traceForTurn (trace precision without local state)", () => {
  const obs = [
    { traceId: "t-second", startTime: "2026-09-08T10:05:00Z" },
    { traceId: "t-first", startTime: "2026-09-08T10:00:30Z" }, // a later span of the first trace
    { traceId: "t-first", startTime: "2026-09-08T10:00:00Z" },
    { traceId: "t-third", startTime: "2026-09-08T10:09:00Z" },
    { startTime: "2026-09-08T09:00:00Z" }, // no traceId — ignored
  ];

  it("orders traces by their EARLIEST observation and indexes by turn number", () => {
    expect(traceForTurn(obs, "turn_0")).toBe("t-first");
    expect(traceForTurn(obs, "turn_1")).toBe("t-second");
    expect(traceForTurn(obs, "turn_2")).toBe("t-third");
  });

  it("returns undefined rather than guessing when the ordinal is not there yet", () => {
    expect(traceForTurn(obs, "turn_3")).toBeUndefined();
    expect(traceForTurn([], "turn_0")).toBeUndefined();
  });

  it("refuses turn ids that are not eve's turn_N shape", () => {
    expect(traceForTurn(obs, "0")).toBeUndefined();
    expect(traceForTurn(obs, "turn_x")).toBeUndefined();
  });
});

describe("windowStats", () => {
  const scores: ScoreRow[] = [
    row({ id: "a", value: 1, timestamp: inside, environment: "production" }),
    row({ id: "b", value: 0, timestamp: inside, environment: "production", comment: "meh" }),
    row({ id: "c", value: 1, timestamp: inside, environment: "development" }),
    row({ id: "d", value: 1, timestamp: before }), // prior window
    row({ id: "e", name: "feedback-reason", stringValue: "too_slow", timestamp: inside }),
  ];

  it("counts only user-feedback votes inside the window", () => {
    const s = windowStats(scores, FROM, TO);
    expect(s.total).toBe(3);
    expect(s.up).toBe(2);
    expect(s.down).toBe(1);
    expect(s.positiveRate).toBeCloseTo(2 / 3);
    expect(s.withComment).toBe(1);
    expect(s.byEnvironment.production).toEqual({ up: 1, down: 1 });
    expect(s.byEnvironment.development).toEqual({ up: 1, down: 0 });
  });

  it("reports null positive rate on an empty window, not NaN", () => {
    expect(windowStats(scores, "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z").positiveRate).toBeNull();
  });
});

describe("histogram", () => {
  it("counts categorical values, most frequent first, with correlate hints", () => {
    const scores: ScoreRow[] = [
      row({ id: "1", name: "feedback-reason", stringValue: "too_slow", timestamp: inside }),
      row({ id: "2", name: "feedback-reason", stringValue: "too_slow", timestamp: inside }),
      row({ id: "3", name: "feedback-reason", stringValue: "incorrect", timestamp: inside }),
      row({ id: "4", name: "feedback-reason", stringValue: "incorrect", timestamp: before }),
    ];
    const h = histogram(scores, "feedback-reason", FROM, TO);
    expect(h).toHaveLength(2);
    expect(h[0]).toMatchObject({ value: "too_slow", count: 2 });
    expect(h[0].correlate).toContain("duration_ms");
    expect(h[1]).toMatchObject({ value: "incorrect", count: 1 });
  });
});

describe("samplePlainUps", () => {
  it("samples only comment-less 👍 with a traceId, newest first, deterministically", () => {
    const scores: ScoreRow[] = [
      row({ id: "up-old", value: 1, traceId: "t1", timestamp: "2026-09-02T00:00:00Z" }),
      row({ id: "up-new", value: 1, traceId: "t2", timestamp: "2026-09-06T00:00:00Z" }),
      row({ id: "up-commented", value: 1, traceId: "t3", comment: "great", timestamp: inside }),
      row({ id: "down", value: 0, traceId: "t4", timestamp: inside }),
      row({ id: "up-no-trace", value: 1, timestamp: inside }),
    ];
    const s = samplePlainUps(scores, FROM, TO, 5);
    expect(s.map((x) => x.id)).toEqual(["up-new", "up-old"]);
    expect(samplePlainUps(scores, FROM, TO, 1).map((x) => x.id)).toEqual(["up-new"]);
  });
});

describe("rateByDigest", () => {
  it("groups by digest, largest group first, unknown digests bucketed", () => {
    const out = rateByDigest([
      { value: 1, digest: "aaa" },
      { value: 0, digest: "aaa" },
      { value: 1, digest: "aaa" },
      { value: 1, digest: undefined },
    ]);
    expect(out[0]).toEqual({ digest: "aaa", total: 3, up: 2, positiveRate: 2 / 3 });
    expect(out[1]).toEqual({ digest: "(unknown)", total: 1, up: 1, positiveRate: 1 });
  });
});

describe("promote routing", () => {
  it("routes each verdict per its declared promote target", () => {
    expect(datasetForVerdict("good-example")).toBe(GOLDEN_DATASET);
    expect(datasetForVerdict("wrong-answer")).toBe(REGRESSION_DATASET);
    for (const v of ["data-gap", "not-a-defect"]) {
      expect(datasetForVerdict(v)).toBeNull();
    }
    expect(datasetForVerdict(undefined)).toBeNull();
    expect(datasetForVerdict("not-a-verdict")).toBeNull();
    // Retired 7-value labels must not silently route anywhere.
    for (const v of ["incorrect", "partially-correct", "unclear-question", "ux-issue", "other"]) {
      expect(datasetForVerdict(v)).toBeNull();
    }
  });

  it("verdictByTrace keeps the LATEST verdict when a reviewer re-classifies", () => {
    const verdicts = verdictByTrace([
      row({ id: "v1", name: "review-verdict", traceId: "t1", stringValue: "wrong-answer", timestamp: "2026-09-01T00:00:00Z" }),
      row({ id: "v2", name: "review-verdict", traceId: "t1", stringValue: "not-a-defect", timestamp: "2026-09-05T00:00:00Z" }),
      row({ id: "v3", name: "review-verdict", traceId: "t2", stringValue: "good-example", timestamp: inside }),
      row({ id: "x", name: "user-feedback", traceId: "t3", value: 0, timestamp: inside }),
    ]);
    expect(verdicts.get("t1")).toBe("not-a-defect");
    expect(verdicts.get("t2")).toBe("good-example");
    expect(verdicts.has("t3")).toBe(false);
  });

  it("dataset item ids are stable per trace (idempotent promote)", () => {
    expect(datasetItemId("abc")).toBe("fb-abc");
    expect(datasetItemId("abc")).toBe(datasetItemId("abc"));
  });
});

import { describe, expect, it } from "vitest";
import { reformulate } from "../workflow/stages/2-reformulate";
import { ctx, fakeLlm } from "./_fakes";

const Q = "Ich suche einen Sportverein in Dortmund, der mir nach meiner Knieverletzung beim Wiedereinstieg ins Training helfen kann.";

describe("stage 2 — reformulate", () => {
  it("rewrites the question and keeps the original untouched", async () => {
    const llm = fakeLlm({ reformulated: "Sportverein in Dortmund für den Wiedereinstieg nach Knieverletzung, Rehabilitation." });
    const r = await reformulate({ query: Q }, ctx({}, { llm }));
    expect(r.output).toMatchObject({ originalUserQuery: Q, reformulated: true, model: "fake-model" });
    expect(r.output.retrievalQuery).toMatch(/Rehabilitation/);
    expect(llm.calls[0]).toEqual({ fn: "reformulate", arg: Q });
  });

  it("is the identity when disabled", async () => {
    const llm = fakeLlm();
    const r = await reformulate({ query: Q }, ctx({ enableQueryReformulation: false }, { llm }));
    expect(r.output).toEqual({ originalUserQuery: Q, retrievalQuery: Q, reformulated: false });
    expect(llm.calls).toEqual([]);
  });

  it("falls back to the original with a warning when the model fails", async () => {
    const r = await reformulate({ query: Q }, ctx({}, { llm: fakeLlm({ failReformulate: new Error("429") }) }));
    expect(r.output.retrievalQuery).toBe(Q);
    expect(r.output.reformulated).toBe(false);
    expect(r.warnings?.[0]).toMatch(/429/);
  });

  it("falls back when the model returns an empty string and truncates over-long output", async () => {
    const empty = await reformulate({ query: Q }, ctx({}, { llm: fakeLlm({ reformulated: "   " }) }));
    expect(empty.output.reformulated).toBe(false);
    const long = await reformulate({ query: Q }, ctx({ maxRetrievalQueryChars: 60 }, { llm: fakeLlm({ reformulated: "x".repeat(200) }) }));
    expect(long.output.retrievalQuery).toHaveLength(60);
    expect(long.warnings?.[0]).toMatch(/truncated/);
  });

  it("records config", async () => {
    const r = await reformulate({ query: Q }, ctx());
    expect(r.config).toEqual({ enableQueryReformulation: true, maxRetrievalQueryChars: 400 });
  });
});

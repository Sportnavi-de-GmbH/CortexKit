import { describe, expect, it } from "vitest";
import { runWorkflow } from "../workflow/run-workflow";
import { deps, fakeEmbed, fakeLlm, ruhrWorld } from "./_fakes";

const Q = "Ich suche einen Sportverein in Dortmund, der mir nach meiner Knieverletzung beim Wiedereinstieg ins Training helfen kann.";
const happy = () => deps({ llm: fakeLlm({ cityMention: "Dortmund", reformulated: "Reha-Sport Dortmund Knie", answer: "**Gefunden.**" }) });

describe("runWorkflow", () => {
  it("runs all six stages in order and returns answer + recommendations", async () => {
    const t = await runWorkflow({ query: Q }, { maxNearbyHubs: 0 }, happy());
    expect(t.status).toBe("ok");
    expect(t.stages.map((s) => [s.id, s.status])).toEqual([
      ["detect-city", "ok"], ["reformulate", "ok"], ["nearby-cities", "ok"], ["search", "ok"], ["rerank", "ok"], ["respond", "ok"],
    ]);
    expect(t.answer).toBe("**Gefunden.**");
    expect(t.recommendations?.length).toBe(5);
    expect(t.config.topKReranked).toBe(5);
    expect(t.totalMs).toBeGreaterThanOrEqual(0);
    for (const s of t.stages) expect(s.durationMs).toBeGreaterThanOrEqual(0);
    expect((t.stages[3]!.output as { retrievalQuery: string }).retrievalQuery).toBe("Reha-Sport Dortmund Knie");
  });

  it("stops with needs_clarification when no city resolves; later stages are skipped", async () => {
    const t = await runWorkflow({ query: "Ich suche Yoga" }, {}, deps({ llm: fakeLlm({ cityMention: null }) }));
    expect(t.status).toBe("needs_clarification");
    expect(t.clarification).toMatch(/Stadt/);
    expect(t.stages[0]!.status).toBe("warning");
    expect(t.stages.slice(1).every((s) => s.status === "skipped")).toBe(true);
    expect(t.stages).toHaveLength(6);
  });

  it("records a stage error and skips the rest when the embedding fails", async () => {
    const t = await runWorkflow({ query: Q }, {}, deps({ llm: fakeLlm({ cityMention: "Dortmund" }), embed: fakeEmbed(undefined, new Error("embed down")) }));
    expect(t.status).toBe("failed");
    expect(t.stages[3]).toMatchObject({ id: "search", status: "error", error: { message: "embed down" } });
    expect(t.stages[4]!.status).toBe("skipped");
    expect(t.stages[5]!.status).toBe("skipped");
  });

  it("marks a stage 'warning' when it has warnings, and echoes the effective config", async () => {
    const t = await runWorkflow({ query: Q }, { searchRadiusKm: 60, maxNearbyHubs: 0 }, deps({ llm: fakeLlm({ cityMention: "Dortmund" }), backend: ruhrWorld({ failCities: ["Bochum"] }) }));
    expect(t.stages[3]!.status).toBe("warning");
    expect(t.config.searchRadiusKm).toBe(60);
  });

  it("returns a failed trace (not a throw) on an invalid config", async () => {
    const t = await runWorkflow({ query: Q }, { topKSimilarity: 99 }, happy());
    expect(t.status).toBe("failed");
    expect(t.stages).toEqual([]);
    expect(t.clarification).toBeUndefined();
    expect((t as { error?: { message: string } }).error?.message).toMatch(/topKSimilarity/);
  });

  it("a run deadline surfaces as that stage's error", async () => {
    const slow = ruhrWorld();
    slow.resolveCityFuzzy = () => new Promise(() => {});
    const t = await runWorkflow({ query: Q }, { runTimeoutMs: 1000, callTimeoutMs: 100 }, deps({ llm: fakeLlm({ cityMention: "Dortmund" }), backend: slow }));
    expect(t.status).toBe("needs_clarification"); // resolve timed out → attempt rejected → no city
    expect(t.stages[0]!.output).toMatchObject({ attempts: [{ accepted: false, reason: expect.stringMatching(/abort|timeout/i) }] });
  });
});

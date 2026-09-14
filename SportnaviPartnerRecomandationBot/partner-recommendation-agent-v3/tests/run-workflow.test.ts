import { describe, expect, it } from "vitest";
import { runWorkflow } from "../workflow/run-workflow";
import { deps, fakeBackend, fakeEmbed, fakeLlm, rawTask, resolveKnownCity, ruhrWorld, CENTROIDS } from "./_fakes";
import type { Task } from "../workflow/types";

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
    expect(t.error?.message).toMatch(/embed down/);
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
    // resolve timed out → infrastructure failure → stage 1 errors, the run fails (never a clarification)
    expect(t.status).toBe("failed");
    expect(t.stages[0]!.status).toBe("error");
    expect(t.stages[0]!.error?.message).toMatch(/abort|timeout/i);
    expect(t.stages.slice(1).every((s) => s.status === "skipped")).toBe(true);
    expect(t.stages).toHaveLength(6);
  });
});

const T = (query: string, cityMention: string | null = null, priority = 1) => rawTask({ label: query, query, cityMention, priority });
const task = (id: string, query: string): Task => ({ id, label: query, query, cityMention: null, priority: 1 });

/** A world that resolves Dortmund/Bochum/Essen and records how many tasks are inside resolveCityFuzzy at once. */
function slowWorld(delayMs = 30) {
  let inFlight = 0, peak = 0;
  const backend = fakeBackend({
    resolveCityFuzzy: async (place) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, delayMs));
      inFlight--;
      return resolveKnownCity(place);
    },
    cityCentroids: CENTROIDS,
    matchPartners: () => [],
    getPartnerProfiles: () => [],
  });
  return { backend, peak: () => peak };
}

describe("runWorkflow — multi-task", () => {
  it("single task: trace has decompose + one TaskRun, and stages/answer are the classic single-run shape", async () => {
    const t = await runWorkflow({ query: Q }, { maxNearbyHubs: 0 }, happy());
    expect(t.decompose.status).toBe("ok");
    expect(t.tasks).toHaveLength(1);
    expect(t.tasks[0]!.status).toBe("ok");
    expect(t.stages).toBe(t.tasks[0]!.stages);
    expect(t.stages.map((s) => s.id)).toEqual(["detect-city", "reformulate", "nearby-cities", "search", "rerank", "respond"]);
    expect(t.answer).toBe("**Gefunden.**");
    expect(t.deferred).toEqual([]);
    expect(t.pending).toEqual([]);
    // stage 0's hint means stage 1 never called the detect model
    expect((t.stages[0]!.config as { cityMentionSource: string }).cityMentionSource).toBe("hint");
  });

  it("runs three tasks concurrently (peak in-flight = 3) and composes three sections", async () => {
    const world = slowWorld();
    const llm = fakeLlm({ decompose: [T("Tennis in Dortmund", "Dortmund"), T("Boxen in Bochum", "Bochum", 2), T("Yoga in Essen", "Essen", 3)], answer: (p) => `A:${/Gesuchte Stadt: (\w+)/.exec(p)?.[1]}` });
    const t = await runWorkflow({ query: "drei Dinge" }, { maxNearbyHubs: 0, maxNearbyCities: 0 }, deps({ llm, backend: world.backend }));
    expect(t.status).toBe("ok");
    expect(t.tasks.map((x) => x.status)).toEqual(["ok", "ok", "ok"]);
    expect(world.peak()).toBe(3);
    expect(t.answer).toBe("**Tennis in Dortmund**\nA:Dortmund\n\n**Boxen in Bochum**\nA:Bochum\n\n**Yoga in Essen**\nA:Essen");
    expect(t.stages).toEqual([]);
    expect(t.tasks[1]!.stages[0]!.input).toMatchObject({ query: "Boxen in Bochum", cityMention: "Bochum" });
  });

  it("never runs more than maxTasksPerTurn: the rest is deferred and named in the answer", async () => {
    const world = slowWorld();
    const five = [T("Tennis in Dortmund", "Dortmund"), T("Boxen in Bochum", "Bochum", 2), T("Yoga in Essen", "Essen", 3), T("Klettern in Köln", "Köln", 4), T("Schwimmen in Essen", "Essen", 5)];
    const t = await runWorkflow({ query: "fünf Dinge" }, { maxNearbyHubs: 0, maxNearbyCities: 0 }, deps({ llm: fakeLlm({ decompose: five }), backend: world.backend }));
    expect(t.tasks).toHaveLength(3);
    expect(world.peak()).toBeLessThanOrEqual(3);
    expect(t.deferred.map((d) => d.query)).toEqual(["Klettern in Köln", "Schwimmen in Essen"]);
    expect(t.answer).toContain("(Notiert für danach: Klettern in Köln, Schwimmen in Essen");
    expect(t.status).toBe("ok");
  });

  it("maxTasksPerTurn=2 with three tasks ⇒ peak 2, one deferred", async () => {
    const world = slowWorld();
    const llm = fakeLlm({ decompose: [T("Tennis in Dortmund", "Dortmund"), T("Boxen in Bochum", "Bochum", 2), T("Yoga in Essen", "Essen", 3)] });
    const t = await runWorkflow({ query: "x" }, { maxTasksPerTurn: 2, maxNearbyHubs: 0, maxNearbyCities: 0 }, deps({ llm, backend: world.backend }));
    expect(t.tasks).toHaveLength(2);
    expect(world.peak()).toBe(2);
    expect(t.deferred).toHaveLength(1);
  });

  it("one task without a city ⇒ the others finish, status needs_clarification, the task is returned as pending", async () => {
    const llm = fakeLlm({ decompose: [T("Tennis in Dortmund", "Dortmund"), T("Rückenschmerzen", null, 3), T("Boxen in Bochum", "Bochum", 2)], answer: "A" });
    const t = await runWorkflow({ query: "x" }, { maxNearbyHubs: 0 }, deps({ llm }));
    expect(t.status).toBe("needs_clarification");
    expect(t.tasks.map((x) => x.status)).toEqual(["ok", "ok", "needs_clarification"]);
    expect(t.pending.map((p) => p.label)).toEqual(["Rückenschmerzen"]);
    expect(t.clarification).toMatch(/für „Rückenschmerzen“/);
    expect(t.answer).toBe(`**Tennis in Dortmund**\nA\n\n**Boxen in Bochum**\nA\n\n${t.clarification}`);
    expect(t.tasks[2]!.stages.slice(1).every((s) => s.status === "skipped")).toBe(true);
  });

  it("one task failing while another succeeds ⇒ partial, with the failed section and the error mirrored", async () => {
    const backend = ruhrWorld({ failCities: [] });
    let n = 0;
    const embed = async (text: string) => { n++; if (text.includes("Boxen")) throw new Error("embed down"); return (await fakeEmbed()(text)); };
    const llm = fakeLlm({ decompose: [T("Tennis in Dortmund", "Dortmund"), T("Boxen in Bochum", "Bochum", 2)], reformulated: (q) => q, answer: "A" });
    const t = await runWorkflow({ query: "x" }, { maxNearbyHubs: 0 }, deps({ llm, backend, embed }));
    expect(n).toBe(2);
    expect(t.status).toBe("partial");
    expect(t.tasks.map((x) => x.status)).toEqual(["ok", "failed"]);
    expect(t.answer).toContain("Bei „Boxen in Bochum“ ist gerade etwas schiefgelaufen");
    expect(t.error?.message).toMatch(/Boxen in Bochum: .*embed down/);
  });

  it("all tasks failing ⇒ failed", async () => {
    const llm = fakeLlm({ decompose: [T("Tennis in Dortmund", "Dortmund"), T("Boxen in Bochum", "Bochum", 2)] });
    const t = await runWorkflow({ query: "x" }, {}, deps({ llm, embed: fakeEmbed(undefined, new Error("embed down")) }));
    expect(t.status).toBe("failed");
    expect(t.answer).toBeUndefined();
    expect(t.error?.message).toMatch(/Tennis in Dortmund: .*embed down; Boxen in Bochum: .*embed down/);
  });

  it("enableDecomposition=false ⇒ stage 0 skipped, one task, stage 1 asks the model", async () => {
    const llm = fakeLlm({ cityMention: "Dortmund", decompose: [T("nie", "Essen")] });
    const t = await runWorkflow({ query: Q }, { enableDecomposition: false, maxNearbyHubs: 0 }, deps({ llm }));
    expect(t.decompose.status).toBe("skipped");
    expect(t.tasks).toHaveLength(1);
    expect(llm.calls.map((c) => c.fn)).toContain("detectCity");
    expect(t.tasks[0]!.stages[0]!.output).toMatchObject({ target: { canonical: "Dortmund" } });
  });

  it("a degraded decomposition lets stage 1 ask the model (no null hint)", async () => {
    const llm = fakeLlm({ cityMention: "Dortmund", failDecompose: new Error("model down") });
    const t = await runWorkflow({ query: Q }, { maxNearbyHubs: 0 }, deps({ llm }));
    expect(t.decompose.status).toBe("warning");
    expect(t.status).toBe("ok");
    expect(llm.calls.map((c) => c.fn)).toContain("detectCity");
  });

  it("resume: deferred tasks run first, a pending task is merged and re-run", async () => {
    const resume = { pending: [task("p1", "Tennis")], deferred: [task("d1", "Yoga in Essen")] };
    const llm = fakeLlm({
      decompose: (_q, pending) => [rawTask({ label: "Tennis in Dortmund", query: "Tennis in Dortmund", cityMention: "Dortmund", resolvesPending: pending[0]!.id })],
      cityMention: (q) => (q.includes("Essen") ? "Essen" : null),
      answer: "A",
    });
    const t = await runWorkflow({ query: "Dortmund", resume }, { maxNearbyHubs: 0 }, deps({ llm }));
    expect(t.decompose.input).toMatchObject({ pending: ["p1"], deferred: ["d1"] });
    expect(t.tasks.map((x) => x.task.id)).toEqual(["d1", "p1"]);
    expect(t.tasks.map((x) => x.status)).toEqual(["ok", "ok"]);
    expect(t.pending).toEqual([]);
  });

  it("invalid config ⇒ failed with an empty task list and a skipped stage 0", async () => {
    const t = await runWorkflow({ query: Q }, { maxTasksPerTurn: 9 }, happy());
    expect(t.status).toBe("failed");
    expect(t.tasks).toEqual([]);
    expect(t.decompose.status).toBe("skipped");
    expect(t.error?.message).toMatch(/maxTasksPerTurn/);
  });
});

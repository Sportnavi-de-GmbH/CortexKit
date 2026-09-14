import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_CONFIG, loadConfigFromEnv, resolveConfig } from "../config/workflow.config";

describe("workflow config", () => {
  it("has the spec defaults", () => {
    expect(DEFAULT_CONFIG).toMatchObject({
      cityConfidenceMin: 0.6, enableQueryReformulation: true, maxRetrievalQueryChars: 400,
      searchRadiusKm: 30, maxNearbyCities: 5, maxNearbyHubs: 2, includeTargetCity: true,
      topKSimilarity: 15, similarityThreshold: 0.2, maxParallelSearches: 4,
      topKReranked: 5, targetCityBonus: 0.05, maxDistancePenalty: 0.05, minNearbyRelevance: 0.15,
      reranker: "embedding", runTimeoutMs: 45_000, callTimeoutMs: 8_000, modelTimeoutMs: 20_000,
      enableDecomposition: true, maxTasksPerTurn: 3,
    });
    expect(DEFAULT_CONFIG.targetCity).toBeUndefined();
  });

  it("reads env overrides and reports which were set", () => {
    const { config, envSet } = loadConfigFromEnv({
      V3_SEARCH_RADIUS_KM: "45", V3_ENABLE_REFORMULATION: "false", V3_TOP_K_SIMILARITY: "20",
    } as unknown as NodeJS.ProcessEnv);
    expect(config.searchRadiusKm).toBe(45);
    expect(config.enableQueryReformulation).toBe(false);
    expect(config.topKSimilarity).toBe(20);
    expect(envSet.sort()).toEqual(["enableQueryReformulation", "searchRadiusKm", "topKSimilarity"]);
  });

  it("ignores blank or non-numeric env values", () => {
    const { config, envSet } = loadConfigFromEnv({ V3_SEARCH_RADIUS_KM: "", V3_TOP_K_RERANKED: "abc" } as unknown as NodeJS.ProcessEnv);
    expect(config.searchRadiusKm).toBe(30);
    expect(config.topKReranked).toBe(5);
    expect(envSet).toEqual([]);
  });

  it("applies precedence override > env > default", () => {
    const cfg = resolveConfig({ searchRadiusKm: 10 }, { V3_SEARCH_RADIUS_KM: "45", V3_TOP_K_RERANKED: "7" } as unknown as NodeJS.ProcessEnv);
    expect(cfg.searchRadiusKm).toBe(10);
    expect(cfg.topKReranked).toBe(7);
    expect(cfg.maxNearbyCities).toBe(5);
  });

  it("validates ranges", () => {
    expect(() => resolveConfig({ topKSimilarity: 41 }, {} as unknown as NodeJS.ProcessEnv)).toThrow(ConfigError);
    expect(() => resolveConfig({ similarityThreshold: 1.5 }, {} as unknown as NodeJS.ProcessEnv)).toThrow(ConfigError);
    expect(() => resolveConfig({ maxParallelSearches: 0 }, {} as unknown as NodeJS.ProcessEnv)).toThrow(ConfigError);
    expect(() => resolveConfig({ topKReranked: 0 }, {} as unknown as NodeJS.ProcessEnv)).toThrow(ConfigError);
    expect(() => resolveConfig({ reranker: "llm" as never }, {} as unknown as NodeJS.ProcessEnv)).toThrow(ConfigError);
  });

  it("keeps an explicit targetCity override and trims it", () => {
    expect(resolveConfig({ targetCity: "  Bochum " }, {} as unknown as NodeJS.ProcessEnv).targetCity).toBe("Bochum");
    expect(resolveConfig({ targetCity: "   " }, {} as unknown as NodeJS.ProcessEnv).targetCity).toBeUndefined();
  });

  it("has the stage-0 defaults and reads their env vars", () => {
    expect(DEFAULT_CONFIG.enableDecomposition).toBe(true);
    expect(DEFAULT_CONFIG.maxTasksPerTurn).toBe(3);
    const { config, envSet } = loadConfigFromEnv({ V3_ENABLE_DECOMPOSITION: "false", V3_MAX_TASKS_PER_TURN: "2" } as unknown as NodeJS.ProcessEnv);
    expect(config.enableDecomposition).toBe(false);
    expect(config.maxTasksPerTurn).toBe(2);
    expect(envSet.sort()).toEqual(["enableDecomposition", "maxTasksPerTurn"]);
  });

  it("never allows more than 3 tasks per turn", () => {
    expect(() => resolveConfig({ maxTasksPerTurn: 4 }, {} as unknown as NodeJS.ProcessEnv)).toThrow(ConfigError);
    expect(() => resolveConfig({ maxTasksPerTurn: 0 }, {} as unknown as NodeJS.ProcessEnv)).toThrow(/maxTasksPerTurn/);
    expect(() => resolveConfig({ maxTasksPerTurn: 2.5 }, {} as unknown as NodeJS.ProcessEnv)).toThrow(/maxTasksPerTurn/);
    expect(resolveConfig({ maxTasksPerTurn: 1 }, {} as unknown as NodeJS.ProcessEnv).maxTasksPerTurn).toBe(1);
  });
});

import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  mergeConfig,
  PRESETS,
  validateConfig,
  type PartnerInjectionConfig,
} from "../agent/config/partner-injection.config";

describe("validateConfig", () => {
  it("throws when minPartners < 1", () => {
    expect(() =>
      validateConfig({ ...DEFAULT_CONFIG, minPartners: 0 }),
    ).toThrow(/minPartners/);
  });

  it("throws when maxCities < 1", () => {
    expect(() => validateConfig({ ...DEFAULT_CONFIG, maxCities: 0 })).toThrow(
      /maxCities/,
    );
  });

  it("throws when finalRecommendations < 1", () => {
    expect(() =>
      validateConfig({ ...DEFAULT_CONFIG, finalRecommendations: 0 }),
    ).toThrow(/finalRecommendations/);
  });

  it("throws when similarityThreshold < 0", () => {
    expect(() =>
      validateConfig({ ...DEFAULT_CONFIG, similarityThreshold: -0.1 }),
    ).toThrow(/similarityThreshold/);
  });

  it("throws when similarityThreshold > 1", () => {
    expect(() =>
      validateConfig({ ...DEFAULT_CONFIG, similarityThreshold: 1.1 }),
    ).toThrow(/similarityThreshold/);
  });

  it("throws when maxDistanceKm is 0", () => {
    expect(() =>
      validateConfig({ ...DEFAULT_CONFIG, maxDistanceKm: 0 }),
    ).toThrow(/maxDistanceKm/);
  });

  it("throws when maxDistanceKm is negative", () => {
    expect(() =>
      validateConfig({ ...DEFAULT_CONFIG, maxDistanceKm: -5 }),
    ).toThrow(/maxDistanceKm/);
  });

  it("allows maxDistanceKm: null (off)", () => {
    const { warnings } = validateConfig({
      ...DEFAULT_CONFIG,
      maxDistanceKm: null,
    });
    expect(warnings).toEqual([]);
  });

  it("clamps minPartners down to maxPartners and warns, never throws", () => {
    const { cfg, warnings } = validateConfig({
      ...DEFAULT_CONFIG,
      minPartners: 100,
      maxPartners: 40,
    });
    expect(cfg.minPartners).toBe(40);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/clamping minPartners/);
  });

  it("does not warn when minPartners <= maxPartners", () => {
    const { warnings } = validateConfig(DEFAULT_CONFIG);
    expect(warnings).toEqual([]);
  });
});

describe("PRESETS", () => {
  const presetNames: Array<keyof typeof PRESETS> = [
    "LOCAL_FIRST",
    "WIDE_NET",
    "STRICT_CITY",
  ];

  it.each(presetNames)("%s validates cleanly", (name) => {
    const preset: PartnerInjectionConfig = PRESETS[name];
    expect(() => validateConfig(preset)).not.toThrow();
  });

  it("STRICT_CITY disables gap-fill via maxCities: 1", () => {
    expect(PRESETS.STRICT_CITY.maxCities).toBe(1);
  });
});

describe("mergeConfig", () => {
  it("merges overrides over DEFAULT_CONFIG", () => {
    const { config, warnings } = mergeConfig({ maxPartners: 100 });
    expect(config.maxPartners).toBe(100);
    expect(config.minPartners).toBe(DEFAULT_CONFIG.minPartners);
    expect(warnings).toEqual([]);
  });

  it("returns DEFAULT_CONFIG unchanged when called with no overrides", () => {
    const { config } = mergeConfig();
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it("re-validates and throws on an invalid override", () => {
    expect(() => mergeConfig({ similarityThreshold: 1.5 })).toThrow(
      /similarityThreshold/,
    );
  });

  it("re-validates and clamps on a min>max override", () => {
    const { config, warnings } = mergeConfig({
      minPartners: 999,
      maxPartners: 50,
    });
    expect(config.minPartners).toBe(50);
    expect(warnings).toHaveLength(1);
  });
});

describe("includeContactInShortlist", () => {
  it("defaults to true", () => {
    expect(DEFAULT_CONFIG.includeContactInShortlist).toBe(true);
  });
});

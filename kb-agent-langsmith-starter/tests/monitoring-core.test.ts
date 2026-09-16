import { describe, it, expect } from "vitest";
import { isMonitoringEnabled, monitoringEnvironment, agentVersion, dashboardEnabled } from "../lib/monitoring/env";
import { usageCost } from "../lib/monitoring/pricing";
import { describeStep, STEP_DESCRIPTIONS } from "../lib/monitoring/describe";
import { sumUsage } from "../lib/monitoring/types";

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

describe("monitoring env", () => {
  it("is disabled without both url and key", () => {
    expect(isMonitoringEnabled(env({}))).toBe(false);
    expect(isMonitoringEnabled(env({ MONITORING_SUPABASE_URL: "https://x.supabase.co" }))).toBe(false);
    expect(
      isMonitoringEnabled(
        env({ MONITORING_SUPABASE_URL: "https://x.supabase.co", MONITORING_SUPABASE_SERVICE_ROLE_KEY: "k" }),
      ),
    ).toBe(true);
  });
  it("environment falls back MONITORING_ENVIRONMENT → VERCEL_ENV → NODE_ENV", () => {
    expect(monitoringEnvironment(env({ MONITORING_ENVIRONMENT: "staging", VERCEL_ENV: "preview" }))).toBe("staging");
    expect(monitoringEnvironment(env({ VERCEL_ENV: "preview", NODE_ENV: "production" }))).toBe("preview");
    expect(monitoringEnvironment(env({ NODE_ENV: "test" }))).toBe("test");
  });
  it("agent version prefers the Vercel sha", () => {
    expect(agentVersion(env({ VERCEL_GIT_COMMIT_SHA: "0123456789abcdefXYZ" }))).toBe("0123456789ab");
    expect(agentVersion(env({ MONITORING_NO_GIT: "1" }))).toBe("dev");
  });
  it("dashboard needs password AND cookie secret", () => {
    expect(dashboardEnabled(env({ MONITORING_PASSWORD: "p" }))).toBe(false);
    expect(dashboardEnabled(env({ MONITORING_PASSWORD: "p", MONITORING_COOKIE_SECRET: "s".repeat(32) }))).toBe(true);
  });
});

describe("pricing", () => {
  it("prices known models and returns undefined for unknown/absent usage", () => {
    expect(usageCost("gpt-4.1-mini", { input: 1_000_000, output: 0 })).toBeCloseTo(0.4, 6);
    expect(usageCost("mystery", { input: 10, output: 10 })).toBeUndefined();
    expect(usageCost("gpt-4.1", undefined)).toBeUndefined();
  });
  it("sums step usage into trace totals", () => {
    const step = (o: Record<string, unknown>) =>
      ({ step_key: "x", sequence: 1, kind: "llm", name: "x", title: "x", purpose: "x.", status: "ok", ...o }) as never;
    expect(
      sumUsage([step({ tokens_input: 10, tokens_output: 1, cost_estimate_usd: 0.1 }), step({ tokens_input: 5, tokens_cached: 2 })]),
    ).toEqual({ tokens_input: 15, tokens_output: 1, tokens_cached: 2, cost_estimate_usd: 0.1 });
  });
});

describe("describe", () => {
  const NAMES = [
    "request-received", "load-knowledge-base", "generate-answer", "answer-delivered", "failure", "decompose", "task",
    "detect-city", "reformulate", "nearby-cities", "search", "rerank", "respond", "answer-composed", "tool",
  ];
  it.each(NAMES)("has a title and a one-sentence purpose for %s", (n) => {
    const d = describeStep(n);
    expect(d.title.length).toBeGreaterThan(2);
    expect(d.purpose.endsWith(".")).toBe(true);
    expect(d.purpose.split(". ").length).toBe(1);
  });
  it("interpolates the task label and the KB digest", () => {
    expect(describeStep("task", { label: "Yoga in Bochum" }).title).toBe("Task — Yoga in Bochum");
    expect(describeStep("load-knowledge-base", { digest: "abc123" }).purpose).toContain("abc123");
  });
  it("falls back to a generic description for unknown names", () => {
    expect(describeStep("something-new")).toEqual({ title: "something-new", purpose: "This step has no description yet." });
    expect(Object.keys(STEP_DESCRIPTIONS).length).toBeGreaterThanOrEqual(NAMES.length);
  });
});

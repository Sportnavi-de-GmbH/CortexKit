import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const AGENT_ROOT = path.resolve(__dirname, "../agent");

/**
 * These tests guard the ASSEMBLED PROMPT, which is shipped on every model call
 * and is therefore both the biggest latency cost and the place correctness
 * silently rots. Two real incidents motivated most of what is asserted here:
 *
 *  - The agent once answered a partner request entirely from its own
 *    knowledge, inventing five studios with fabricated details, because an
 *    instruction rewrite weakened the grounding mandate. That mandate is now
 *    asserted explicitly.
 *  - The instructions kept referencing tools that had been deleted, and a
 *    skill file kept prescribing a superseded three-call sequence. Stale
 *    references are now a test failure, not something you notice in prod.
 */

describe("agent/instructions.md", () => {
  const instructions = readFileSync(
    path.join(AGENT_ROOT, "instructions.md"),
    "utf8",
  );

  it("makes coverage a database decision, not a from-memory one", () => {
    expect(instructions).toMatch(/Coverage — the database decides/i);
  });

  it("states similarity search is for gap-filling only", () => {
    expect(instructions.toLowerCase()).toContain("similarity search is for gap-filling only");
  });

  /**
   * Rule #6 was INVERTED on 2026-08-01. It used to read "Never reveal PII…
   * Even then, confirm first", which made Navio withhold the public contact
   * details a partner published in order to be contacted — worse at the job
   * for no privacy benefit. Contact data is public directory information and
   * belongs in the answer.
   */
  it("tells Navio to share partner contact details rather than withhold them", () => {
    expect(instructions).toMatch(/Share contact details/i);
    expect(instructions).not.toMatch(/Never reveal PII/i);
  });

  /**
   * The half that must NOT be relaxed: contact details are bound by the
   * grounding mandate more strictly than prose is. A plausible-looking wrong
   * phone number sends a real person to the wrong place, and the user cannot
   * detect the error until it has already cost them.
   */
  it("keeps contact details bound to the grounding mandate", () => {
    expect(instructions).toMatch(/Copy contact details \*exactly\*/i);
    expect(instructions).toMatch(/never guess, complete, correct/i);
  });

  /**
   * `not_available` is the placeholder in ~96% of live profiles, so the
   * missing-field path is the common path — and echoing the raw token to a
   * user would violate rule #9 (never quote internals).
   */
  it("handles missing contact fields without echoing the internal placeholder", () => {
    expect(instructions).toContain("not_available");
    expect(instructions).toMatch(/never echo the token itself to the user/i);
  });

  it("references only tools that still exist", () => {
    for (const tool of ["find_partners", "get_partner_details"]) {
      expect(instructions).toContain(tool);
    }
  });

  /**
   * REGRESSION GUARD. Deleted tools must not linger in the prompt: they cost
   * tokens on every call and invite the model back onto a path that no longer
   * exists. The one sanctioned mention is the sentence explaining that
   * find_partners replaced them, so we assert they never appear as an
   * instruction to CALL them.
   */
  it("never instructs the model to call a removed tool", () => {
    for (const removed of [
      "extract_city",
      "resolve_partners",
      "build_recommendations",
      "find_nearby_cities",
      "get_partners_by_city",
      "similarity_search_partners",
      "partner-curator",
    ]) {
      expect(instructions).not.toMatch(new RegExp(`call\\s+\`?${removed}`, "i"));
    }
  });

  /**
   * THE MOST IMPORTANT ASSERTION IN THIS FILE. Without an explicit grounding
   * mandate the model will answer partner requests from its own knowledge —
   * measured, not hypothetical. A cheap, fast, fabricating agent scores better
   * than a correct one on every efficiency metric, so this is the only thing
   * standing between an optimization and a reputational incident.
   */
  it("forbids answering a partner request from the model's own knowledge", () => {
    expect(instructions).toMatch(/partner data of your own/i);
    expect(instructions).toMatch(/never heard of any\s+partner/i);
    expect(instructions).toMatch(/stop and call the tool instead/i);
  });

  /**
   * Placement matters as much as wording. With the mandate only in the step
   * list (~line 60), a measured 1-in-16 city requests were answered with
   * invented studios. Restating it as a blockquote in the opening preamble
   * took that to 0/20. Assert it stays near the top, not just present
   * somewhere.
   */
  it("states the no-invented-partners rule in the opening preamble", () => {
    const preamble = instructions.slice(0, 2000);
    expect(preamble).toMatch(/You do not know any partners/i);
    expect(preamble).toMatch(/stop and call\s+`?find_partners`?/i);
  });

  it("does not point at a skills file (skills were removed)", () => {
    expect(instructions).not.toContain("SKILL.md");
  });
});

describe("agent/instructions/002-city-coverage.md", () => {
  const coveragePath = path.join(
    AGENT_ROOT,
    "instructions",
    "002-city-coverage.md",
  );
  const coverage = readFileSync(coveragePath, "utf8");

  it("starts with the expected heading", () => {
    expect(coverage.startsWith("## Largest cities we operate in (partner count)")).toBe(true);
  });

  it("contains Bielefeld (100)", () => {
    expect(coverage).toContain("Bielefeld (100)");
  });

  it("says plainly that it is not the coverage authority", () => {
    expect(coverage).toMatch(/NOT the full coverage list/i);
  });

  /**
   * REGRESSION GUARD. This file used to hold all ~650 cities — 10,417 chars
   * (~2,600 tokens) on EVERY model call, for a decision the database already
   * makes better. It is now the 40 largest, kept only so the agent can offer
   * concrete alternatives. If a regeneration ever dumps the full list again,
   * fail here rather than in the latency graph.
   */
  it("stays small — it is a shortlist, not the full directory", () => {
    expect(coverage.length).toBeLessThan(2000);
    const entries = coverage.match(/\(\d+\)/g) ?? [];
    expect(entries.length).toBeLessThanOrEqual(60);
    expect(entries.length).toBeGreaterThanOrEqual(20);
  });
});

describe("agent capability surface", () => {
  it("has no skills directory (the partner-injection skill was superseded)", () => {
    expect(existsSync(path.join(AGENT_ROOT, "skills"))).toBe(false);
  });

  it("has no subagents directory (partner-curator was never invoked)", () => {
    expect(existsSync(path.join(AGENT_ROOT, "subagents"))).toBe(false);
  });

  /**
   * Every advertised tool costs schema tokens on every model call. The search
   * path is one tool; the only other live one is the follow-up lookup. The
   * rest of agent/tools/ is `disableTool()` sentinels turning OFF eve
   * built-ins (shell, filesystem, web, self-delegation).
   */
  it("advertises exactly the two tools the product needs", () => {
    const toolsDir = path.join(AGENT_ROOT, "tools");
    const live = readdirSync(toolsDir)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => !readFileSync(path.join(toolsDir, f), "utf8").includes("disableTool"));

    expect(live.sort()).toEqual(["find_partners.ts", "get_partner_details.ts"]);
  });
});

/**
 * agent-graph.test.ts — the config assertion from the architecture proposal (§9-R3).
 *
 * WHY THIS TEST EXISTS
 * The single most dangerous failure mode in this project is silent and invisible
 * in code review: a declared subagent inherits NOTHING from the root, and an
 * absent slot falls back to the FRAMEWORK DEFAULT rather than the root's version
 * (eve 0.25.3 docs/subagents.mdx, "The isolation boundary"). Delete or forget one
 * file under agent/subagents/faq/tools/ and the FAQ agent quietly regains
 * `web_search` — giving it a source of truth outside the curated knowledge base,
 * which is the one thing it must never have.
 *
 * Nothing about that failure is visible at runtime until the agent cites a random
 * website. So we assert the resolved tool surface instead of trusting the files.
 *
 * It reads eve's COMPILED MANIFEST, i.e. what the framework actually resolved —
 * not what the directory listing suggests. Run `npx eve info` (or any eve
 * command) first to refresh it; `npm run typecheck && npx eve info && npm test`
 * is the intended pre-commit sequence.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const MANIFEST = path.join(
  process.cwd(),
  ".eve",
  "compile",
  "compiled-agent-manifest.json",
);

type AgentNode = {
  disabledFrameworkTools: string[];
  tools: { name: string }[];
  config?: { name?: string; description?: string };
  subagents?: { agent: AgentNode }[];
};

/** Every built-in eve ships in its default harness. */
const ALL_FRAMEWORK_TOOLS = [
  "agent",
  "ask_question",
  "bash",
  "glob",
  "grep",
  "load_skill",
  "read_file",
  "todo",
  "web_fetch",
  "web_search",
  "write_file",
];

function loadManifest(): AgentNode | null {
  if (!existsSync(MANIFEST)) return null;
  return JSON.parse(readFileSync(MANIFEST, "utf8")) as AgentNode;
}

const manifest = loadManifest();

describe.skipIf(manifest === null)("resolved agent graph", () => {
  const root = manifest as AgentNode;

  describe("master (root)", () => {
    it("exposes exactly the three authored tools", () => {
      expect(root.tools.map((t) => t.name).sort()).toEqual([
        "find_partners",
        "provide_booking_link",
        "request_human_contact",
      ]);
    });

    it("keeps ask_question ENABLED — it is the ambiguity mechanism (§3.3)", () => {
      // If this ever flips to disabled, the master loses its only way to ask a
      // clarifying question and will guess instead.
      expect(root.disabledFrameworkTools).not.toContain("ask_question");
    });

    it("disables every other built-in, including the root-only `agent` tool", () => {
      const expected = ALL_FRAMEWORK_TOOLS.filter((t) => t !== "ask_question").sort();
      expect([...root.disabledFrameworkTools].sort()).toEqual(expected);
    });

    it("declares the faq subagent", () => {
      const names = (root.subagents ?? []).map((s) => s.agent.config?.name);
      expect(names).toContain("faq");
    });
  });

  describe("faq subagent", () => {
    const faq = (root.subagents ?? []).find((s) => s.agent.config?.name === "faq")?.agent;

    it("is present", () => {
      expect(faq).toBeDefined();
    });

    it("is COMPLETELY tool-free — the isolation boundary is satisfied", () => {
      // The load-bearing assertion. All 11 built-ins disabled, zero authored tools.
      expect([...(faq?.disabledFrameworkTools ?? [])].sort()).toEqual(
        [...ALL_FRAMEWORK_TOOLS].sort(),
      );
      expect(faq?.tools ?? []).toHaveLength(0);
    });

    it("never regains web_search", () => {
      // Called out separately from the assertion above because this is the one
      // that actually matters: web_search would give the FAQ agent a source of
      // truth outside the curated knowledge base.
      expect(faq?.disabledFrameworkTools).toContain("web_search");
    });

    it("has a routing description with an explicit negative clause", () => {
      // Routing regressions almost always trace to a vague description rather
      // than to the router model. The "NICHT für …" half is what separates
      // "how does check-in work" (faq) from "where can I check in" (find_partners).
      const description = faq?.config?.description ?? "";
      expect(description.length).toBeGreaterThan(80);
      expect(description).toMatch(/NICHT/);
    });
  });
});

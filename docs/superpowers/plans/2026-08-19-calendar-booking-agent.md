# Calendar Booking Capability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `provide_booking_link` tool to the `navio-orchestrator` master agent so the
router can hand visitors a static scheduling URL on explicit booking intent, without any
calendar read/write access or approval gate.

**Architecture:** A third authored tool on the master (`agent/tools/provide_booking_link.ts`),
peer to `find_partners` and `request_human_contact`, returning `{ available, bookingUrl? }`
from a single `BOOKING_URL` env var. No subagent, no Microsoft Graph, no approval gate — see
`docs/superpowers/specs/2026-08-19-calendar-booking-agent-design.md` for the full rationale.
The routing prompt (`agent/instructions.md`) gets one new capability entry and one
disambiguation row against `request_human_contact`. The Langfuse routing table
(`lib/langfuse.ts`) gets a fifth route so the new capability traces into `Navio — Multi-Agent`
the same way the other three already do.

**Tech Stack:** eve 0.25.x (`defineTool` from `eve/tools`), Zod, TypeScript, Vitest.

## Global Constraints

- Scope is `navio-orchestrator/` only — do not touch `kb-agent-langsmith-starter/` or
  `SportnaviPartnerRecomandationBot/` (workspace `CLAUDE.md` §14).
- No approval gate on this tool (confirmed in design §2 — it collects no PII and triggers no
  irreversible action, unlike `request_human_contact`).
- `inputSchema: z.object({})` — no parameters (confirmed in design §3 — one static URL, nothing
  to disambiguate).
- Never commit `.env.local`; only `.env.example` gets the new `BOOKING_URL` documentation line.
- Pre-commit sequence for this project is `npm run typecheck && npm run agent:info && npm test`
  (`navio-orchestrator/CLAUDE.md` §4) — `agent:info` (`eve info`) must run before `npm test`
  whenever the tool surface changes, because `tests/agent-graph.test.ts` reads the compiled
  manifest at `.eve/compile/compiled-agent-manifest.json`, not the source files.
- No Claude/Anthropic attribution in commit messages (workspace memory: no-claude-commit-attribution).

---

### Task 1: `provide_booking_link` tool + unit test

**Files:**
- Create: `navio-orchestrator/agent/tools/provide_booking_link.ts`
- Create: `navio-orchestrator/tests/booking-link.test.ts`

**Interfaces:**
- Produces: default export `provide_booking_link` (eve auto-registers it from the filename —
  no manual wiring in `agent/agent.ts`), with `execute(): Promise<{ available: boolean; bookingUrl?: string }>`.
  This is what Task 3 asserts appears in the compiled manifest's root tool list, and what
  Task 4's prompt changes name in `agent/instructions.md`.

- [ ] **Step 1: Write the failing test**

Create `navio-orchestrator/tests/booking-link.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import tool from "../agent/tools/provide_booking_link.ts";

describe("provide_booking_link", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the configured URL when BOOKING_URL is set", async () => {
    vi.stubEnv("BOOKING_URL", "https://calendly.com/sportnavi/demo");

    const result = await tool.execute({}, {} as never);

    expect(result).toEqual({
      available: true,
      bookingUrl: "https://calendly.com/sportnavi/demo",
    });
  });

  it("trims surrounding whitespace from BOOKING_URL", async () => {
    vi.stubEnv("BOOKING_URL", "  https://calendly.com/sportnavi/demo  ");

    const result = await tool.execute({}, {} as never);

    expect(result.bookingUrl).toBe("https://calendly.com/sportnavi/demo");
  });

  it("degrades to available: false — never throws — when BOOKING_URL is unset", async () => {
    vi.stubEnv("BOOKING_URL", "");

    const result = await tool.execute({}, {} as never);

    expect(result).toEqual({ available: false });
  });

  it("has a routing description with an explicit NICHT clause", () => {
    // Mirrors the assertion agent-graph.test.ts makes on the faq subagent's
    // description (tests/agent-graph.test.ts) — the description is the API,
    // and routing regressions almost always trace to a missing negative clause.
    expect(tool.description.length).toBeGreaterThan(60);
    expect(tool.description).toMatch(/NICHT/);
  });

  it("carries no approval gate — unlike request_human_contact", () => {
    // Confirms the design decision (spec §2): this is read-only with no
    // consequential action, so it must never gain an approval() call.
    expect(tool.approval).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd navio-orchestrator && npx vitest run tests/booking-link.test.ts`
Expected: FAIL — `Cannot find module '../agent/tools/provide_booking_link.ts'` (the file does
not exist yet).

- [ ] **Step 3: Write the tool**

Create `navio-orchestrator/agent/tools/provide_booking_link.ts`:

```ts
import { defineTool } from "eve/tools";
import { z } from "zod";

/**
 * provide_booking_link — hands the visitor a static scheduling URL.
 *
 * Read-only by design: no calendar API, no write path, no approval gate.
 * Unlike request_human_contact, this collects no PII and triggers no
 * irreversible action inside Navio — the visitor leaves the chat entirely to
 * complete the booking on the external platform. See
 * docs/superpowers/specs/2026-08-19-calendar-booking-agent-design.md §2 for
 * why this is a plain tool, not a subagent, and carries no approval().
 *
 * Missing BOOKING_URL degrades the same way PARTNER_AGENT_HOST unset does
 * elsewhere in Navio: the capability quietly becomes unavailable, nothing
 * throws, and the rest of the widget is unaffected.
 */
export default defineTool({
  description:
    "Gibt den Buchungslink zur Terminvereinbarung mit dem Sportnavi-Team zurück " +
    "(z. B. für eine Produktdemo oder ein Beratungsgespräch). Nutze das NUR bei " +
    "explizitem Terminwunsch (\"Termin\", \"Demo\", \"Beratungsgespräch\", \"Zeit " +
    "vereinbaren\"). NICHT für Support, Rechnungen, Kündigungen oder allgemeine " +
    "Fragen — dafür ist request_human_contact zuständig.",
  inputSchema: z.object({}),
  async execute() {
    const url = process.env.BOOKING_URL?.trim();
    if (!url) {
      return { available: false as const };
    }
    return { available: true as const, bookingUrl: url };
  },
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd navio-orchestrator && npx vitest run tests/booking-link.test.ts`
Expected: PASS — 5 tests green.

- [ ] **Step 5: Commit**

```bash
cd navio-orchestrator
git add agent/tools/provide_booking_link.ts tests/booking-link.test.ts
git commit -m "feat(navio-orchestrator): add provide_booking_link tool"
```

---

### Task 2: `BOOKING_URL` env var documentation

**Files:**
- Modify: `navio-orchestrator/.env.example`

**Interfaces:**
- Consumes: nothing (documentation-only task).
- Produces: nothing new — documents the env var Task 1's tool already reads via
  `process.env.BOOKING_URL`.

- [ ] **Step 1: Add the env var block**

In `navio-orchestrator/.env.example`, after the `# --- Partner agent (service 2) ---` block
(ends at the `PARTNER_PROXY_SECRET=` line, currently line 95) and before the
`# --- LangSmith (EU) ---` block, insert:

```
# --- Booking link (read-only scheduling hand-off) ---
# Reached from agent/tools/provide_booking_link.ts. No calendar API, no write
# access — the tool only returns this URL for the master to relay verbatim.
# UNSET = the tool returns { available: false } and the master falls back to
# request_human_contact; the rest of Navio keeps working.
BOOKING_URL=
```

- [ ] **Step 2: Verify the file is still valid shell-style env syntax**

Run: `cd navio-orchestrator && grep -c "^BOOKING_URL=" .env.example`
Expected: `1`

- [ ] **Step 3: Commit**

```bash
cd navio-orchestrator
git add .env.example
git commit -m "docs(navio-orchestrator): document BOOKING_URL env var"
```

---

### Task 3: Assert the tool in the compiled agent graph

**Files:**
- Modify: `navio-orchestrator/tests/agent-graph.test.ts:66-71`

**Interfaces:**
- Consumes: `provide_booking_link` existing as a registered tool (from Task 1) so `eve info`
  picks it up into the compiled manifest.
- Produces: nothing — this is a config-drift assertion, the last line of defense described in
  the file's own header comment.

- [ ] **Step 1: Update the failing expectation**

In `navio-orchestrator/tests/agent-graph.test.ts`, replace:

```ts
    it("exposes exactly the two authored tools", () => {
      expect(root.tools.map((t) => t.name).sort()).toEqual([
        "find_partners",
        "request_human_contact",
      ]);
    });
```

with:

```ts
    it("exposes exactly the three authored tools", () => {
      expect(root.tools.map((t) => t.name).sort()).toEqual([
        "find_partners",
        "provide_booking_link",
        "request_human_contact",
      ]);
    });
```

- [ ] **Step 2: Refresh the compiled manifest**

Run: `cd navio-orchestrator && npm run agent:info`
Expected: exits 0, `0 errors, 0 warnings` (mirrors the verified state recorded in
`navio-orchestrator/CLAUDE.md` §5). This regenerates
`.eve/compile/compiled-agent-manifest.json`, which the test reads directly — running the test
before this step re-checks a stale manifest and is a false pass/fail either way.

- [ ] **Step 3: Run the test to verify it passes**

Run: `cd navio-orchestrator && npx vitest run tests/agent-graph.test.ts`
Expected: PASS — all tests in the `master (root)` and `faq subagent` describe blocks green,
including the updated three-tool assertion.

- [ ] **Step 4: Commit**

```bash
cd navio-orchestrator
git add tests/agent-graph.test.ts
git commit -m "test(navio-orchestrator): assert provide_booking_link in compiled agent graph"
```

---

### Task 4: Routing prompt changes

**Files:**
- Modify: `navio-orchestrator/agent/instructions.md`

**Interfaces:**
- Consumes: `provide_booking_link` (Task 1) and `request_human_contact` (existing) as the two
  tool names referenced in the disambiguation text.
- Produces: nothing code-facing — this is prompt content, verified by manual/eval testing
  later (Task 6 notes the not-yet-built `evals/datasets/routing.json` as a followup), not by a
  unit test in this plan.

- [ ] **Step 1: Add the 4th capability entry**

In `navio-orchestrator/agent/instructions.md`, immediately after the existing block:

```
**3. `request_human_contact` — an einen Menschen übergeben**

Nutze das nach den Regeln im Abschnitt ESKALATION. Es öffnet das Kontaktformular.
```

insert a new capability, renumbering nothing else (this becomes item 4, since the file already
introduces the section with "Du hast drei Fähigkeiten" — update that count too):

```
**4. `provide_booking_link` — einen Termin vereinbaren**

Nutze das für: einen expliziten Terminwunsch (Demo, Beratungsgespräch, „Termin
vereinbaren"). Gibt einen Buchungslink zurück, den die Nutzerin selbst öffnet.

Beispiele: „Kann ich eine Demo buchen?" · „Ich hätte gern einen Termin mit euch" ·
„Wie kann ich ein Beratungsgespräch vereinbaren?"

NICHT für: Support, Rechnungen, Kündigungen, Beschwerden oder „ich will mit
jemandem sprechen" ohne Terminbezug — dafür ist `request_human_contact` zuständig.
```

- [ ] **Step 2: Update the capability count**

In the same file, change:

```
Du hast drei Fähigkeiten. Deine einzige echte Aufgabe ist es, die richtige zu wählen.
```

to:

```
Du hast vier Fähigkeiten. Deine einzige echte Aufgabe ist es, die richtige zu wählen.
```

- [ ] **Step 3: Add the disambiguation row**

In the same file, in the "Frage | Richtig" table (the one starting with
`| „Wie funktioniert der Check-in?" | ...`), add two rows at the end of the table body:

```
| „Ich will mit jemandem sprechen" (kein Terminbezug) | `request_human_contact` |
| „Kann ich einen Termin vereinbaren?" | `provide_booking_link` |
```

- [ ] **Step 4: Fold the config-gap case into rule R9**

In the same file, replace:

```
**R9 — Wenn eine Fähigkeit einen Fehler zurückgibt**, erfinde nichts. Sage ehrlich, dass
es gerade nicht geklappt hat, und biete an, es erneut zu versuchen oder an das Team zu
übergeben.
```

with:

```
**R9 — Wenn eine Fähigkeit einen Fehler zurückgibt**, erfinde nichts. Sage ehrlich, dass
es gerade nicht geklappt hat, und biete an, es erneut zu versuchen oder an das Team zu
übergeben. Gibt `provide_booking_link` `available: false` zurück, erfinde KEINEN Link —
sage, dass die Terminbuchung gerade nicht verfügbar ist, und biete stattdessen
`request_human_contact` an.
```

- [ ] **Step 5: Verify the file still reads correctly**

Run: `cd navio-orchestrator && grep -c "provide_booking_link" agent/instructions.md`
Expected: `4` (the capability heading, the NICHT clause under `request_human_contact`'s
description is not present, the disambiguation row, and the R9 addition — count may vary
slightly by exact wording chosen in Step 1/3/4, but must be ≥ 3, confirming all three edits
landed).

- [ ] **Step 6: Commit**

```bash
cd navio-orchestrator
git add agent/instructions.md
git commit -m "feat(navio-orchestrator): route explicit scheduling intent to provide_booking_link"
```

---

### Task 5: Langfuse routing table + tests

**Files:**
- Modify: `navio-orchestrator/lib/langfuse.ts` (7 edit sites — see below)
- Modify: `navio-orchestrator/tests/langfuse.test.ts`

**Interfaces:**
- Consumes: the string `"provide_booking_link"` as the tool/route name (must match Task 1's
  filename-derived tool name exactly, since `routeForTool` matches on it).
- Produces: `Route` union member `"provide_booking_link"`, `ROUTES.provide_booking_link`,
  `SPAN.provideBookingLink`, all of which Task 6's manual verification step
  (`scripts/verify-langfuse.ts --expect-route provide_booking_link`) depends on.

- [ ] **Step 1: Write the failing test additions**

In `navio-orchestrator/tests/langfuse.test.ts`, extend the existing `"names each capability,
bare or prefixed"` test (around line 117-122):

```ts
  it("names each capability, bare or prefixed", () => {
    expect(humanSpanName("faq")).toBe(SPAN.delegateFaq);
    expect(humanSpanName("execute_tool find_partners")).toBe(SPAN.findPartners);
    expect(humanSpanName("request_human_contact")).toBe(SPAN.humanContact);
    expect(humanSpanName("ask_question")).toBe(SPAN.askQuestion);
    expect(humanSpanName("provide_booking_link")).toBe(SPAN.provideBookingLink);
  });
```

Extend the existing `"maps every capability to a route..."` test (around line 158-163):

```ts
  it("maps every capability to a route, and refuses to guess for unknown ones", () => {
    expect(routeForTool("faq")).toBe("faq");
    expect(routeForTool("find_partners")).toBe("find_partners");
    expect(routeForTool("request_human_contact")).toBe("request_human_contact");
    expect(routeForTool("provide_booking_link")).toBe("provide_booking_link");
    expect(routeForTool("something_new")).toBeUndefined();
  });
```

Add a new assertion in the `"routing"` describe block, after the `"says WHERE each route's
work is traced..."` test:

```ts
  it("traces the booking route inside this project, not a separate service", () => {
    // Unlike find_partners (service 2) or faq (a local subagent with its own
    // child session), provide_booking_link is a static config lookup with no
    // delegation at all — its work is entirely within this trace.
    expect(ROUTES.provide_booking_link.tracedIn).toBe("this trace");
    expect(ROUTES.provide_booking_link.handler).not.toMatch(/subagent|HTTP|service 2/i);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd navio-orchestrator && npx vitest run tests/langfuse.test.ts`
Expected: FAIL — `SPAN.provideBookingLink` is `undefined`, `routeForTool("provide_booking_link")`
returns `undefined` instead of the expected route, and `ROUTES.provide_booking_link` is
`undefined`.

- [ ] **Step 3: Extend the routing table in `lib/langfuse.ts`**

In `navio-orchestrator/lib/langfuse.ts`, make these six edits:

**3a.** Extend the `Route` union (currently at `~L193-198`):

```ts
export type Route =
  | "faq"
  | "find_partners"
  | "request_human_contact"
  | "provide_booking_link"
  | "ask_question"
  | "direct_reply";
```

**3b.** Add an entry to `ROUTES` (currently at `~L209-235`), inserted after the
`request_human_contact` entry and before `ask_question`:

```ts
  request_human_contact: {
    label: "human hand-off",
    handler: "approval gate → Kontaktformular → Salesforce",
    tracedIn: "this trace",
  },
  provide_booking_link: {
    label: "booking link",
    handler: "the orchestrator itself (static config, no delegation)",
    tracedIn: "this trace",
  },
  ask_question: {
```

**3c.** Extend `routeForTool` (currently at `~L240-246`):

```ts
export function routeForTool(toolName: string): Route | undefined {
  if (toolName === "faq") return "faq";
  if (toolName === "find_partners") return "find_partners";
  if (toolName === "request_human_contact") return "request_human_contact";
  if (toolName === "provide_booking_link") return "provide_booking_link";
  if (toolName === "ask_question") return "ask_question";
  return undefined;
}
```

**3d.** Extend `SPAN` (currently at `~L252-273`), adding a member after `humanContact`:

```ts
  /** The `request_human_contact` tool. */
  humanContact: "hand-off-to-human",
  /** The `provide_booking_link` tool. */
  provideBookingLink: "hand-off-booking-link",
  /** eve's built-in clarification tool (ENABLED on this agent, unlike the others). */
  askQuestion: "ask-visitor-to-clarify",
```

**3e.** Extend `TOOL_SPANS` (currently at `~L279-284`):

```ts
export const TOOL_SPANS: Record<string, string> = {
  faq: SPAN.delegateFaq,
  find_partners: SPAN.findPartners,
  request_human_contact: SPAN.humanContact,
  provide_booking_link: SPAN.provideBookingLink,
  ask_question: SPAN.askQuestion,
};
```

**3f.** Extend `STEP_PURPOSE` (currently at `~L304-325`) — **required**, not optional: the test
at `~L128-132` (`"gives every named stage a purpose line"`) iterates every `SPAN` value and
fails if any is missing an entry here. Add after the `SPAN.humanContact` entry:

```ts
  [SPAN.humanContact]:
    "Escalation to a human: opens the approval gate and the Kontaktformular.",
  [SPAN.provideBookingLink]:
    "Static config lookup — returns the pre-configured scheduling URL for the " +
    "router to relay verbatim. No delegation, no external call, no approval gate.",
  [SPAN.askQuestion]:
```

- [ ] **Step 4: Extend `TOOL_STORIES`**

In the same file, find `TOOL_STORIES` (search for `export const TOOL_STORIES`, around `~L659`)
and add an entry after `request_human_contact`:

```ts
  request_human_contact: {
    human: "the human hand-off",
    user_goal: "Reach a person at Sportnavi",
  },
  provide_booking_link: {
    human: "the booking link",
    user_goal: "Schedule a meeting with the Sportnavi team",
  },
  ask_question: { human: "a clarifying question", user_goal: "Be understood correctly" },
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd navio-orchestrator && npx vitest run tests/langfuse.test.ts`
Expected: PASS — all tests green, including the three new/extended assertions from Step 1.

- [ ] **Step 6: Run the full suite to confirm nothing else regressed**

Run: `cd navio-orchestrator && npm run typecheck && npm test`
Expected: `tsc --noEmit` exits 0; `vitest run` reports all suites passing (44+ tests — the
project's `CLAUDE.md` §5 records 43 as the pre-existing baseline, plus the tests added in
Tasks 1 and 5 of this plan).

- [ ] **Step 7: Commit**

```bash
cd navio-orchestrator
git add lib/langfuse.ts tests/langfuse.test.ts
git commit -m "feat(navio-orchestrator): trace provide_booking_link as a fifth Langfuse route"
```

---

### Task 6: Docs — supersede the old plan, note the manual verification step

**Files:**
- Modify: `navio-orchestrator/CLAUDE.md` (§3 layout, §6 conventions)
- Modify: `docs/NAVIO-MULTI-AGENT-ARCHITECTURE.md` (§4.4, §11)
- Modify: `navio-orchestrator/scripts/verify-langfuse.ts:22` (usage comment only)

**Interfaces:**
- Consumes: nothing — documentation-only task, run last so it can describe the
  already-implemented state accurately.
- Produces: nothing code-facing.

- [ ] **Step 1: Update `navio-orchestrator/CLAUDE.md` §3 (layout)**

In the `## 3. Layout` code block, after the line:

```
│   ├── request_human_contact.ts approval: always()  ← runtime gate, not a prompt rule
```

insert:

```
│   ├── provide_booking_link.ts  no approval — static config, no side effects
```

- [ ] **Step 2: Update `navio-orchestrator/CLAUDE.md` §6 (conventions)**

Append a sentence to the existing "Adding agent N" convention bullet, noting this capability as
a worked example of the *simpler* tool-only path (no `disableTool()` sentinels apply, since
there's no subagent isolation boundary to protect):

```
- **Adding agent N** = new `subagents/<id>/` + its own sentinels + ~15 routing eval cases + one
  line in the master's capability map. No framework code. Tool and subagent names share one
  namespace — a collision fails the build. **`provide_booking_link` (2026-08-19) is the simpler
  case**: a capability with no knowledge of its own is a plain tool, not a subagent — no
  isolation boundary, no `disableTool()` sentinels, just the tool file + a capability-map line.
```

- [ ] **Step 3: Mark the old Microsoft Graph plan as superseded**

In `docs/NAVIO-MULTI-AGENT-ARCHITECTURE.md`, immediately before the `### 4.4 \`subagents/booking/\`
— phase 2` heading, insert:

```
> **⚠ Superseded 2026-08-19.** The booking capability actually built is read-only with a single
> static URL and no Microsoft Graph connection — see
> `docs/superpowers/specs/2026-08-19-calendar-booking-agent-design.md`. §4.4 below is the
> original phase-4 sketch and was **not implemented as written**; kept for history only.
```

And in the `## 11. Roadmap` table, change the `4. Booking agent` row's deliverable/exit-criteria
cells from:

```
| **4. Booking agent** | `subagents/booking/` + Microsoft Graph connection + `approval: always()` on `book_meeting` | A real meeting appears in a Sportnavi calendar |
```

to:

```
| **4. Booking agent** *(superseded — see `docs/superpowers/specs/2026-08-19-calendar-booking-agent-design.md`)* | `agent/tools/provide_booking_link.ts`, no calendar API | Router hands back the correct static URL on explicit scheduling intent |
```

- [ ] **Step 4: Note the manual post-deploy verification step**

In `navio-orchestrator/scripts/verify-langfuse.ts:22`, the usage comment currently lists valid
`--expect-route` values. Change:

```
//        [--expect-route faq|find_partners|request_human_contact|ask_question|direct_reply]
```

to:

```
//        [--expect-route faq|find_partners|request_human_contact|provide_booking_link|ask_question|direct_reply]
```

This is documentation only — the script already accepts an arbitrary string for
`--expect-route` (it does not validate against the `Route` type), so no script logic changes.
Running `npx tsx scripts/verify-langfuse.ts <sessionId> --expect-route provide_booking_link`
against a real session (after deploying with Azure credentials and a live model) is a manual
verification step, not automated by this plan — record its result in `navio-orchestrator/CLAUDE.md`
§5 ("Verified state") once run, following the same pattern used for the `faq` and
`find_partners` routes.

- [ ] **Step 5: Commit**

```bash
git add navio-orchestrator/CLAUDE.md docs/NAVIO-MULTI-AGENT-ARCHITECTURE.md navio-orchestrator/scripts/verify-langfuse.ts
git commit -m "docs(navio-orchestrator): document provide_booking_link, supersede Graph-based booking plan"
```

---

## Plan self-review notes

- **Spec coverage:** §2 (tool placement, no subagent, no approval) → Task 1. §3 (interface,
  config-gap output shape) → Task 1. §4 (prompt/routing changes) → Task 4. §5 (config) → Task 2.
  §6 (Langfuse) → Task 5. §7 (testing) → Tasks 1, 3, 5 (unit + agent-graph + langfuse tests);
  the routing-eval-dataset item is explicitly called out in Task 5's context as not-yet-buildable
  (the dataset file doesn't exist yet per the architecture doc's own roadmap) rather than silently
  dropped. §8 (docs) → Task 6. §9 (out of scope) — no task builds Graph access, per-topic
  variation, or a subagents/booking/ directory, matching the spec.
- **Type consistency:** the tool's return shape `{ available: boolean; bookingUrl?: string }` is
  used identically in Task 1 (implementation + test) and referenced identically in Task 4's R9
  prompt wording (`available: false`) and Task 5's Langfuse handler text. The tool/route name
  `provide_booking_link` is spelled identically across all six files it touches.

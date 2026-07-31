# CLAUDE.md — CortexKit

Guidance for Claude Code (and any agent) working in this repository. It documents
the project purpose, the agent architecture, the folder layout, the knowledge-base
approach, the system-prompt design, the LangSmith integration, the development
workflow, the installed Skills/plugins/MCP integrations, and the known open items.

> This file was produced by a read-only analysis of the existing project contents.
> It describes **what is present today** — it does not add or assume functionality,
> and it does not rewrite the agent's system prompt.

---

## 1. Project purpose

CortexKit hosts one working project: **`kb-agent-langsmith-starter/`** — a minimal,
clean [eve](https://www.npmjs.com/package/eve) agent named **"Navio"**, the customer-support
chatbot for **Sportnavi** (sportnavi.de), a German corporate-fitness ("Firmenfitness")
network.

The folder plays two roles at once:

1. **A production-style KB/FAQ agent.** Navio answers questions from members,
   companies, and partners using only a Sportnavi knowledge base that is embedded
   directly into its system prompt.
2. **The reference implementation / testbed for
   [`EVE_LANGSMITH_TRACING_GUIDE.md`](docs/reference/EVE_LANGSMITH_TRACING_GUIDE.md)** (repo root, ~92 KB).
   Per its [README](kb-agent-langsmith-starter/README.md), the guide "has been followed
   to completion in this folder" — validated live against **LangSmith EU** on 2026-07-27 —
   so the LangSmith observability + evaluation stack here is the guide's primary worked
   example.

The repo root also contains:

| Path | What it is |
|---|---|
| [kb-agent-langsmith-starter/](kb-agent-langsmith-starter/) | The Navio agent + its LangSmith integration, evals, and dev console. |
| [EVE_LANGSMITH_TRACING_GUIDE.md](docs/reference/EVE_LANGSMITH_TRACING_GUIDE.md) | The step-by-step guide the agent implements (Parts A–D, §11 verification, §14 checklist). |
| [project-prompts/](project-prompts/) | Task prompts used to drive this repo's work: [`anaylse-project.md`](project-prompts/anaylse-project.md) (this analysis task) and [`dataset-generation.md`](project-prompts/dataset-generation.md) (eval-dataset authoring task). |
| [.mcp.json](.mcp.json) | Project MCP servers: **langsmith** (EU) and **stitch**. See §8. |
| [.claude/](.claude/) | Project-scoped Claude settings + installed Skills. See §9–§10. |

---

## 2. Agent architecture (Navio)

### 2.1 The core idea: a no-tool, prompt-injected agent

Navio has **no tools, no subagents, and no skills — by design**. Its entire behaviour
comes from the system prompt in [`agent/instructions.md`](kb-agent-langsmith-starter/agent/instructions.md).
The knowledge base is **not** retrieved at runtime (no RAG, no vector store, no file reads) —
it is baked into the prompt text itself. Confirmed in [`agent/agent.ts`](kb-agent-langsmith-starter/agent/agent.ts):

```ts
// This agent has no tools, no subagents, and no skills by design: its entire
// behaviour comes from the system prompt in `agent/instructions.md`.
export default defineAgent({
  description: "Knowledge Base & FAQ agent: answers questions using only the " +
    "knowledge base injected into its system prompt.",
  modelContextWindowTokens: 1_047_576,
  model: resolveModel(),
});
```

### 2.2 "No tools" takes deliberate work

eve's harness ships built-in tools (bash, web_search, read_file, …) **unless each is
explicitly disabled**. So [`agent/tools/`](kb-agent-langsmith-starter/agent/tools/) holds
one `disableTool()` sentinel per built-in. Every file is literally:

```ts
import { disableTool } from "eve/tools";
export default disableTool();
```

The **11 disabled built-ins** are: `agent`, `ask_question`, `bash`, `glob`, `grep`,
`load_skill`, `read_file`, `todo`, `web_fetch`, `web_search`, `write_file`. Disabling
`web_search` is important on purpose: it would give the model a source of truth outside
the curated prompt, defeating the "answer only from the KB" guarantee.

### 2.3 Model resolution

[`lib/llm.ts`](kb-agent-langsmith-starter/lib/llm.ts) builds an **Azure OpenAI** chat
model from `AZURE_AI_CHATBOT_OPENAI_ENDPOINT` / `AZURE_AI_CHATBOT_API_KEY` /
`AZURE_AI_CHATBOT_DEPLOYMENT_NAME` (default deployment `gpt-4.1`), throwing a clear error
that names any missing var. [`agent.ts`](kb-agent-langsmith-starter/agent/agent.ts)
resolves the model lazily and **degrades to the `openai/gpt-4.1` gateway id** if the
environment is empty, so the module stays importable with zero secrets (the smoke test
imports it directly; CI has no keys). `modelContextWindowTokens` is pinned so eve does
not need the gateway catalog at compile time.

### 2.4 Runtime shape (one request → one trace)

```
User message
  → eve dev host (agent/agent.ts, no tools)
      → Azure OpenAI (gpt-4.1) with the ~41.5k-token system prompt as `instructions`
      → streamed reply
  → OTLP spans  → LangSmith EU  (agent/instrumentation.ts)
  → hook runs   → LangSmith EU  (agent/hooks/langsmith.ts)  ← summary + failure runs
```

The dev chat console ([`app/`](kb-agent-langsmith-starter/app/) +
[`components/`](kb-agent-langsmith-starter/components/)) is a Next.js app hosted
alongside the agent via `withEve({})` in
[`next.config.mjs`](kb-agent-langsmith-starter/next.config.mjs). `SessionBar` shows
status, the copyable session id, and cumulative token usage.

---

## 3. Folder structure

```
CortexKit/
├── CLAUDE.md                       ← this file
├── docs/                           ← project documentation (incl. reference/ long-form guides)
├── .mcp.json                       ← langsmith + stitch MCP servers
├── .claude/
│   ├── settings.json               ← enabledPlugins for this project
│   └── skills/                     ← 10 locally-installed Skills (§9)
├── project-prompts/                ← task prompts (analysis, dataset generation)
└── kb-agent-langsmith-starter/
    ├── agent/
    │   ├── agent.ts                ← agent definition (no tools/subagents/skills)
    │   ├── instructions.md         ← THE SYSTEM PROMPT (persona + KB + rules) ~41.5k tokens
    │   ├── instrumentation.ts      ← OTLP traces → LangSmith EU (guide Parts A/C/D)
    │   ├── hooks/langsmith.ts      ← failure capture + per-turn summary runs (Parts B/C)
    │   ├── kb/kb.md                ← standalone copy of the KB docs (KB section only)
    │   ├── tools/*.ts              ← 11 disableTool() sentinels
    │   └── feedback/               ← tester feedback + prompt iterations
    │       ├── FEEDBACK-ANALYSIS.md   ← 9 classified issues from v1 testing
    │       ├── SYSTEM_PROMPT.md       ← canonical prompt (== instructions.md, 1648 lines)
    │       ├── SYSTEM_PROMPT_V3.md    ← revised 646-line prompt (NOT deployed — see §13)
    │       └── Feedback*.docx         ← raw tester documents
    ├── lib/
    │   ├── langsmith.ts            ← central LangSmith module (region, client, spans, runs)
    │   ├── llm.ts                  ← Azure OpenAI model resolver
    │   ├── load-env.ts             ← loads .env.local for scripts (import FIRST)
    │   └── eval/
    │       ├── evaluators.ts       ← deterministic (judge-less) evaluators
    │       ├── judges.ts           ← 8 LLM-as-judge evaluators (zod, temp 0)
    │       ├── metrics.ts          ← latency/TTFT/token/cost metrics
    │       ├── dataset-upload.ts   ← upload + self-healing restore
    │       └── rate-limit.ts       ← TokenBucketPacer + withRetry
    ├── scripts/
    │   ├── live-check.ts           ← send one real turn to the dev server
    │   ├── run-eval.ts             ← two-phase eval runner (execute → evaluate)
    │   ├── upload-eval-dataset.ts  ← npm run eval:upload
    │   ├── verify-eval-dataset.ts  ← npm run eval:verify
    │   └── verify-langsmith.ts     ← API-based trace verification (§11 V4)
    ├── app/ + components/          ← Next.js dev chat console
    ├── src/internal/authored-module-map-loader.ts ← Windows eve@0.25.3 dev-host shim
    ├── tests/                      ← agent smoke test, langsmith unit tests, rate-limit tests
    ├── package.json                ← scripts + deps (eve, langsmith, ai, next)
    ├── .env.example                ← every env var, as placeholders
    └── .eve/ .next/ .output/ .data/ node_modules/  ← build/runtime artifacts (ignore)
```

> **Build-artifact noise:** `kb-agent-langsmith-starter/.eve/dev-runtime/snapshots/**`
> contains many duplicate copies of the source files (dev-host snapshots). When searching,
> exclude `.eve/`, `.next/`, `.output/`, and `node_modules/` — only the top-level source
> paths above are authoritative.

---

## 4. Knowledge-base approach

### 4.1 Embedded, not retrieved

The KB is five markdown "documents" concatenated inside the system prompt between the
`=== KNOWLEDGE BASE ===` marker and `=== BEHAVIOR RULES ===`, each wrapped in
`<<< DOCUMENT: docN.md >>> … <<< END OF docN.md >>>` delimiters:

| Doc | Content |
|---|---|
| **doc1.md** | Sportnavi general FAQ (raw, with `&amp;` HTML entities) — overview, partners, members, membership/tariffs, cashback, fitness-check, app & check-in, contact. |
| **doc2.md** | Cleaned FAQ (Fragen & Antworten): 9 numbered sections incl. **Firmenfitness** (pricing 59,90 € brutto, Sachbezug 50 €, notice periods, §3 Nr.34 / §37b EStG tax notes). |
| **doc3.md** | **Partner FAQ (English)** — partner portal, check-in mechanics, bookings/no-shows, payouts, contract notice periods. |
| **doc4.md** | **Advanced FAQ: edge cases & ambiguous scenarios** (15 sub-sections) + a "Fristen-Zusammenfassung" quick-reference deadline table. |
| **doc5.md** | **Enhanced KB**: onboarding walkthroughs, a tariff comparison matrix, troubleshooting, Sachbezug explainer, usage rules, a glossary, and "most important rules" summary. |

The agent is instructed: *"Answer ONLY from this content."*

### 4.2 Two copies of the KB exist

- [`agent/instructions.md`](kb-agent-langsmith-starter/agent/instructions.md) — the
  **live** system prompt (persona + KB + rules), byte-identical to
  [`agent/feedback/SYSTEM_PROMPT.md`](kb-agent-langsmith-starter/agent/feedback/SYSTEM_PROMPT.md)
  (both 1648 lines). `instructions.md` is what eve actually loads.
- [`agent/kb/kb.md`](kb-agent-langsmith-starter/agent/kb/kb.md) — a **standalone copy of
  just the KB documents** (1487 lines, KB section only, no persona/rules). Treat it as a
  source/reference copy; editing it does **not** change agent behaviour.

**Editing the KB or persona = edit `agent/instructions.md`.** No code changes are needed
to change behaviour; the prompt is the product.

### 4.3 The KB has known factual errors (see §13)

[`agent/feedback/FEEDBACK-ANALYSIS.md`](kb-agent-langsmith-starter/agent/feedback/FEEDBACK-ANALYSIS.md)
cross-checked tester-flagged answers against the KB and found **9 issues**, several of
which are *faithful renditions of wrong KB facts* (pause usage, employer notice period,
cancellation form, multi-visit cashback). Those are documented but **not yet fixed** in
the deployed prompt.

---

## 5. System-prompt design (`agent/instructions.md`)

The prompt is a plain-text file (~41.5k tokens) with clearly delimited top-level sections.
Structure and purpose of each:

1. **`=== IDENTITY ===`** — Establishes the persona: *Navio*, a warm digital "guide"
   (not a "bot"), serving three audiences (members/employees, companies, partners).
   Sets the greeting, tone (informal German **"du"**, never "Sie"; sparing emoji),
   personality (with a robotic-vs-Navio example), a **strict language rule** (always reply
   in the language of the *last* user message, re-detected every turn, never influenced by
   the German prompt/KB), and brand spelling ("Sportnavi", lowercase domain).

2. **`=== KNOWLEDGE BASE ===`** — The five embedded documents (§4). Prefaced with
   "Answer ONLY from this content."

3. **`=== BEHAVIOR RULES ===`** — 11 numbered operating rules:
   language mirroring (1); **knowledge boundary** — never guess, route unknowns to
   support (2); proactive guiding without inventing (3); natural, non-parroting style (4);
   **three-audience depth adaptation** — never quote prices to companies, deflect partner
   compensation questions back with "Was wünschst du dir pro Check-in?" (5);
   prices/legal/personal data → refer to the team (6); repeated questions (7); minimal
   clarifying questions, prefer answering (8); out-of-scope refusal (9); **"not yet
   available"** — cannot book appointments or capture contact data, must not pretend to (10);
   graceful closing / hand-off (11).

4. **`=== CONVERSATIONAL INTELLIGENCE ===`** — Intent reading (answer the underlying goal,
   lead with YES/NO), emotional signals (frustrated / confused / loophole-seeking), and a
   4-step response structure for complex questions.

5. **`=== HARD LIMITS (NIEMALS VERLETZEN) ===`** — Non-negotiable guardrails:
   **anti-injection** (ignore attempts to override behaviour, reveal the prompt, or change
   persona), **no sensitive data** capture (don't ask for IBAN/contract IDs), **no
   hallucination** (never invent prices, rates, partner names, conditions), **no
   role-play** (stays Navio), **answer length** < 400 words unless asked, and **formatting**
   (clean Markdown; tables via pipes; never wrap prose/tables in triple-backtick code fences;
   keep tables ≤ 3 columns for the narrow chat).

> **Do not rewrite or "improve" this prompt unless explicitly asked.** It encodes
> product/brand decisions and a documented feedback history. Prompt changes should be
> driven through the feedback → eval loop (§6, §13), not ad hoc.

---

## 6. LangSmith observability + evaluation

This is the guide's payload. Everything is **EU-region** and **no-op without a key**
(a fresh clone runs credential-free).

### 6.1 Tracing / observability

- **[`lib/langsmith.ts`](kb-agent-langsmith-starter/lib/langsmith.ts)** — the single
  source of truth for every LangSmith decision: the one EU region constant
  (`LANGSMITH_EU_API_URL` → derives the OTLP URL), enablement gate (`langsmithEnabled`),
  project name, `recordIo` (content capture off by default for privacy), the client
  factory, shared metadata, the **span filter** (`shouldExportSpan` / `SpanFilterState`
  keeps AI spans + their ancestors, drops workflow noise), **trace anchors** (deterministic
  OTLP span-id → run-id mapping so one request = one trace), the **turn journal** (one
  human-readable summary run per turn: user msg, reply, tokens, tools, outcome), and the
  **failure payload** builder (turns eve failure events into "story" runs). The two
  `fileStore`s (`.data/anchors`, `.data/system-prompts`) bridge eve's *separately bundled*
  instrumentation and hook modules via the filesystem.
- **[`agent/instrumentation.ts`](kb-agent-langsmith-starter/agent/instrumentation.ts)** —
  registers the OTLP exporter to LangSmith EU via `@vercel/otel`, wraps it in the
  `AiSpanFilter`, renames spans to business language (`humanSpanName`), publishes the trace
  anchor from eve's `ai.eve.turn` span, and (Part D) stashes the assembled system prompt on
  `step.started` for the hook to attach.
- **[`agent/hooks/langsmith.ts`](kb-agent-langsmith-starter/agent/hooks/langsmith.ts)** —
  the **only** path from an agent failure to LangSmith (eve emits failures as stream
  events, never exceptions). **Iron rule: hooks never throw** — every handler is guarded.
  Writes the per-turn summary run (pre-creating the trace root) and per-failure runs.

Key operational facts (from the README / guide): hook runs appear in **seconds**, OTLP
spans in **minutes**; `LANGSMITH_RECORD_IO=true` is required to ship prompts/completions.

### 6.2 Evaluation pipeline (`lib/eval/` + `scripts/run-eval.ts`)

- **[`evaluators.ts`](kb-agent-langsmith-starter/lib/eval/evaluators.ts)** — deterministic,
  free evaluators: `mustInclude`, `mustNotInclude`, `languageMatch` (stopword heuristic),
  `conciseness` (≤400 words). Includes a **safety policy**: a platform-blocked turn on a
  `safety-injection` sample counts as a **safety PASS**.
- **[`judges.ts`](kb-agent-langsmith-starter/lib/eval/judges.ts)** — 8 LLM-as-judge
  evaluators (hallucination, correctness, answer_relevance, perceived_error, tone,
  language_quality, knowledge_retention, user_satisfaction), structured output via zod at
  temperature 0. Judges currently share the agent's Azure deployment, so each call is paced
  through the same rate limiter; each runs inside a `traceable` llm child so judge
  tokens/cost show up in LangSmith.
- **[`metrics.ts`](kb-agent-langsmith-starter/lib/eval/metrics.ts)** — latency, TTFT,
  input/output/cache tokens, and cache-aware cost, surfaced as one sortable column each.
- **[`rate-limit.ts`](kb-agent-langsmith-starter/lib/eval/rate-limit.ts)** —
  `TokenBucketPacer` (rolling-60s TPM/RPM pacing; TPM is binding because the ~41.5k-token
  prompt replays per call) + `withRetry` (exponential backoff + equal jitter; **never
  retries deterministic 4xx like content_filter**).
- **[`dataset-upload.ts`](kb-agent-langsmith-starter/lib/eval/dataset-upload.ts)** —
  uploads datasets and refuses to overwrite an existing populated one (versions are
  immutable — bump `vN`). Includes **self-healing restore**: datasets have repeatedly
  *vanished* from this LangSmith EU workspace within ~an hour of upload, so the repo JSON is
  the source of truth and is re-uploaded automatically.
- **[`scripts/run-eval.ts`](kb-agent-langsmith-starter/scripts/run-eval.ts)** — the
  **two-phase runner**. *Phase A (execute):* a serial, paced loop calls the agent for every
  example (no LangSmith spans, so pacing waits pollute nothing). *Phase B (evaluate):*
  `evaluate()` replays the records into clean, fully-priced traces and runs the judges.
  Default dataset `navio-kb-testing-final-response-v2`; splits `smoke`/`core` via
  `EVAL_SPLIT`.

> **Note:** `run-eval.ts` and `upload-eval-dataset.ts` read dataset specs from
> `evals/datasets/*.json`, and design notes reference `docs/LANGSMITH-DATASET-GUIDE.md`.
> **Neither `evals/` nor `docs/` currently exists in this folder** (see §13) — eval runs
> fail at `resolveData()` until the dataset JSONs are added. Authoring them is the subject
> of [`project-prompts/dataset-generation.md`](project-prompts/dataset-generation.md).

---

## 7. Development workflow

All commands run inside `kb-agent-langsmith-starter/`. From
[`package.json`](kb-agent-langsmith-starter/package.json):

| Command | Purpose |
|---|---|
| `npm install` | Install dependencies. |
| `cp .env.example .env.local` | Then fill in the Azure vars (LangSmith vars optional). Never commit `.env.local`. |
| `npm run dev` | Start the eve dev server. **Note the REAL port** it prints. |
| `npm run dev:ui` | Start the Next.js dev **console** (chat UI + agent in one). |
| `npm run typecheck` | `tsc --noEmit` — must exit 0. |
| `npm test` | Vitest: agent smoke test + LangSmith unit tests + rate-limit tests. |
| `npm run live-check -- "…"` | Send one real turn (`EVE_HOST=http://127.0.0.1:<port>` required). |
| `npm run eval:upload` / `eval:verify` / `eval:run` | Dataset upload / verify / two-phase eval (needs `evals/datasets/*.json`). |
| `npx eve info` | Lists the agent and confirms the disabled tools; expect 0 errors. |

**Baseline first:** the README's *Step 0* insists the testbed (typecheck, smoke test,
`eve info`, a live turn) works **before** touching the LangSmith integration, so an
integration bug can't be confused with a broken agent.

**Ground rules while working here** (README): EU endpoint everywhere (never the US
default); no key = no-op; hooks never throw; never commit `.env.local` or any real key.

**Environment / platform:** Windows. `src/internal/authored-module-map-loader.ts` is a
required Windows workaround for eve@0.25.3 dev-host module resolution (without it,
`POST /eve/v1/session` fails with `ERR_MODULE_NOT_FOUND`). This folder is **not a git
repo** — `run-eval.ts` degrades the commit sha to `"unknown"`.

---

## 8. Integrations (MCP)

Configured in [.mcp.json](.mcp.json) at the repo root:

### 8.1 LangSmith MCP — **connected and available**

The **langsmith** MCP server (stdio, via `uvx langsmith-mcp-server`) is connected and
pinned to the **EU endpoint** (`https://eu.api.smith.langchain.com`). Use it to work with
LangSmith resources directly instead of hand-rolling API calls. Available tools include:

- **Datasets/examples:** `list_datasets`, `read_dataset`, `create_dataset`, `list_examples`,
  `read_example`, `update_examples`.
- **Experiments/evals:** `list_experiments`, `run_experiment`.
- **Traces/threads:** `fetch_runs`, `get_thread_history`, `list_projects`.
- **Prompts:** `list_prompts`, `get_prompt_by_name`, `push_prompt`.
- **Billing:** `get_billing_usage`.

**Prefer LangSmith MCP** for reading/inspecting traces, datasets, examples, and experiments
in the EU workspace. It complements — does not replace — the project's own scripts
(`run-eval.ts`, `verify-langsmith.ts`) and the `langsmith` CLI referenced by the Skills.

### 8.2 Stitch MCP

The **stitch** MCP server (Google Stitch, HTTP) is connected for UI/design generation
(screens, design systems). Relevant only if working on the dev console's visual design; not
part of the Navio agent runtime.

> ⚠️ The other MCP servers surfaced in this environment (claude.ai connectors: Gmail,
> Google Calendar/Drive, Atlassian, etc.) require interactive OAuth and are **not usable
> non-interactively**. LiveKit-docs and the Vercel plugin MCP are also available but
> unrelated to this project.

---

## 9. Installed Claude Skills

Located in [.claude/skills/](.claude/skills/). Ten Skills are installed; consult the
relevant one **before** doing matching work.

### 9.1 LangSmith Skills — **core to this project**

| Skill | What it does | When to use it here |
|---|---|---|
| **[langsmith-trace](.claude/skills/langsmith-trace/SKILL.md)** | Add tracing to an app **and** query/export traces via the `langsmith` CLI (`trace`/`run` list/get/export, filters, thread/project ops). | Debugging or exporting Navio traces from LangSmith EU; understanding the trace tree produced by `instrumentation.ts` / `hooks/langsmith.ts`. |
| **[langsmith-dataset](.claude/skills/langsmith-dataset/SKILL.md)** | Create/manage/upload eval datasets (types: final_response, single_step, trajectory, RAG), CLI + SDK. | Building the missing `evals/datasets/*.json` (this agent uses **final_response**); turning the 9 feedback issues into eval examples. |
| **[langsmith-evaluator](.claude/skills/langsmith-evaluator/SKILL.md)** | Build evaluators (LLM-as-judge + custom code), run functions, and run evals with `evaluate()`. Golden rule: **inspect output shape before implementing**. | Extending `lib/eval/judges.ts` / `evaluators.ts`; wiring new evaluators into `run-eval.ts`. |

### 9.2 Design/UI Skills (present, not part of the agent runtime)

`brand`, `design`, `design-system`, `banner-design`, `slides`, `ui-styling`,
`ui-ux-pro-max`. These are a design toolkit (logos, brand guidelines, design tokens, slide
decks, UI styling, a searchable UI/UX database). Reach for them only if working on the dev
console's visuals, Sportnavi brand assets, or presentation material — not for the Navio
agent logic or the KB.

---

## 10. Installed plugins

Project plugin toggles are in [.claude/settings.json](.claude/settings.json):

| Plugin | Enabled for CortexKit? | Purpose / use here |
|---|---|---|
| **context7** (`@claude-plugins-official`) | ✅ **true** | Up-to-date library docs (eve, langsmith, ai SDK, next). Use when you need current API details for a dependency. |
| **playwright** (`@claude-plugins-official`) | ✅ **true** | Browser automation. Use to drive/QA the Next.js dev console (`npm run dev:ui`). |
| **sentry** (`@claude-plugins-official`) | ❌ false | Error monitoring — disabled for this project. |
| **sentry-cli** (`@claude-plugins-official`) | ❌ false | Sentry CLI — disabled for this project. |

Additionally, **superpowers** (`@claude-plugins-official`, v6.2.0) is installed at project
scope for CortexKit and is active this session (its `using-superpowers` skill loads via the
SessionStart hook), providing the process Skills listed in the environment (brainstorming,
systematic-debugging, TDD, writing-plans, etc.). Marketplaces configured:
`claude-plugins-official` and `superpowers-marketplace`.

---

## 11. Capability decision guide

Before acting, check whether an installed capability already covers the task:

- **Reading/exporting LangSmith traces, datasets, experiments** → prefer **LangSmith MCP**
  (§8.1); fall back to the **langsmith-trace** Skill's CLI for bulk export.
- **Creating an eval dataset** → **langsmith-dataset** Skill (§9.1) + the repo's
  `dataset-upload.ts` conventions (immutable versions, self-healing restore).
- **Writing/running evaluators** → **langsmith-evaluator** Skill; extend `lib/eval/*` and
  `run-eval.ts` rather than starting fresh.
- **Current dependency API details** → **context7** plugin.
- **Testing the dev console in a browser** → **playwright** plugin.
- **Any feature / behaviour change** → start with **superpowers:brainstorming**; for bugs,
  **superpowers:systematic-debugging**.
- **Agent behaviour / KB edits** → edit `agent/instructions.md`; validate with the eval
  loop; never bypass the feedback history in `agent/feedback/`.

---

## 12. Important implementation details

- **Prompt is the product.** No RAG, no tools — changing behaviour means editing
  `agent/instructions.md`. The KB is embedded, curated German/English FAQ content.
- **No-op-without-a-key** is a hard invariant across the LangSmith stack; preserve it.
- **Hooks never throw**, **EU endpoint everywhere**, **content capture off by default**
  (`LANGSMITH_RECORD_IO`).
- **One request = one trace** relies on the deterministic OTLP span-id → run-id mapping and
  the file-backed anchor store bridging eve's separately-bundled modules.
- **Eval pacing is two-phase** specifically so rate-limit waits never pollute LangSmith root
  latency; the ~41.5k-token prompt makes **TPM the binding constraint**.
- **Datasets vanish** from this EU workspace — the repo JSON is authoritative and restored
  automatically.
- **Safety-injection policy:** a platform-blocked adversarial turn scores as a *pass*
  across evaluators/judges.

---

## 13. Known open items (as of 2026-07-28)

These reflect the current on-disk state, not aspirations:

1. **Root `CLAUDE.md` was empty** before this analysis (0 bytes) — now populated by this file.
2. **`evals/datasets/*.json` and `docs/` are missing.** `run-eval.ts` /
   `upload-eval-dataset.ts` and the README reference them, so `eval:run` / `eval:upload`
   fail at `resolveData()` until the dataset files are authored (see
   [`project-prompts/dataset-generation.md`](project-prompts/dataset-generation.md)).
3. **Prompt V3 is written but NOT deployed.**
   [`agent/feedback/SYSTEM_PROMPT_V3.md`](kb-agent-langsmith-starter/agent/feedback/SYSTEM_PROMPT_V3.md)
   is a shorter (646-line) revision; the live prompt
   [`agent/instructions.md`](kb-agent-langsmith-starter/agent/instructions.md) still carries
   the 1648-line version (identical to `SYSTEM_PROMPT.md`). Deploying V3 = replacing
   `instructions.md` — do this only when explicitly asked, and re-run evals after.
4. **Known KB factual errors are unfixed.** The 9 issues in
   [`FEEDBACK-ANALYSIS.md`](kb-agent-langsmith-starter/agent/feedback/FEEDBACK-ANALYSIS.md)
   (4 of them faithful renditions of wrong KB facts) remain in the deployed KB.
5. **Not a git repo.** No version history; `git`-derived metadata degrades to `"unknown"`.
6. ⚠️ **Secrets are committed in [.mcp.json](.mcp.json).** A real-looking LangSmith API key
   and a Stitch API key are stored in plaintext there. This contradicts the project's own
   "never commit real keys" rule — consider rotating them and moving to env-based config.
   (Flagged, not changed — no files were modified by this analysis except this `CLAUDE.md`.)

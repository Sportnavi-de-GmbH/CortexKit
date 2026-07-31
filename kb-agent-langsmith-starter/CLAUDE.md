# CLAUDE.md — kb-agent-langsmith-starter

Comprehensive project documentation for the **Navio Sportnavi Knowledge Base Agent** and its **LangSmith Observability & Evaluation Stack**.

---

## 1. Project Purpose

`kb-agent-langsmith-starter` is a production-grade, minimal [eve](https://www.npmjs.com/package/eve) framework agent named **Navio** — the digital AI guide for **Sportnavi** ([sportnavi.de](https://sportnavi.de)), Germany's corporate fitness network.

The project serves two core purposes:
1. **Production KB/FAQ Agent:** Answers customer questions for Sportnavi members, employers, and partners using a fully embedded knowledge base in the system prompt.
2. **LangSmith Integration Reference Implementation:** Implements full OpenTelemetry tracing, failure hooks, dataset management, rate-limited evaluation pipelines, LLM-as-a-Judge evaluators, and system prompt optimization workflows.

---

## 2. Agent Architecture

### 2.1 Prompt-Embedded Knowledge Architecture (No Tools)
* **Framework:** `eve` (`eve/agent`, `eve/instrumentation`, `eve/hooks`, `eve/tools`).
* **Tool Policy:** 0 active tools by design. All 10 built-in eve tools (`bash`, `web_search`, `read_file`, `write_file`, `glob`, `grep`, `todo`, `ask_question`, `web_fetch`, `load_skill`) are explicitly disabled using `disableTool()` sentinels in `agent/tools/*.ts`.
* **Knowledge Retrieval:** In-context system prompt injection. No external database, vector store, or RAG pipeline.
* **LLM Provider:** Azure OpenAI (`gpt-4o` / deployment configured via `AZURE_AI_CHATBOT_DEPLOYMENT_NAME`, fallback to `openai/gpt-4.1`).
* **Context Window:** Configured to `1,047,576` tokens in `agent/agent.ts`.

### 2.2 Observability & Telemetry Stack
* **Tracing Engine:** Custom OpenTelemetry provider (`agent/instrumentation.ts`) using `@vercel/otel` and `OTLPHttpProtoTraceExporter`.
* **Trace Exporter Target:** LangSmith EU endpoint (`https://eu.api.smith.langchain.com/otel/v1/traces`).
* **Span Filtering:** `AiSpanFilter` filters framework workflow noise while preserving span ancestor hierarchies for trace visualization.
* **Error & Event Hooks:** `agent/hooks/langsmith.ts` captures stream failures (`step.failed`, `turn.failed`, `session.failed`) and writes summary runs to LangSmith.

---

## 3. Project & Folder Structure

```
kb-agent-langsmith-starter/
├── agent/                         # Core agent logic
│   ├── agent.ts                   # Agent definition and model resolution
│   ├── instructions.md            # Production system prompt + embedded KB (~71 KB)
│   ├── instrumentation.ts         # OpenTelemetry tracing exporter for LangSmith EU
│   ├── hooks/
│   │   └── langsmith.ts           # Stream failure and turn summary hook handlers
│   ├── kb/
│   │   └── kb.md                  # Extracted Knowledge Base reference document (~79 KB)
│   ├── tools/                     # Sentinel tool disables (11 files using disableTool())
│   └── feedback/                  # Tester feedback analysis & root-cause mapping
├── app/                           # Next.js 15 UI Dev Console
│   ├── layout.tsx                 # Root layout with globals.css
│   ├── page.tsx                   # Main chat page rendering ChatPanel
│   └── globals.css                # Tailwind CSS v4 styling
├── components/                    # UI Components
│   ├── ChatPanel.tsx              # Interactive chat interface & session handling
│   └── SessionBar.tsx             # Session management toolbar
├── evals/                         # Evaluation Datasets
│   └── datasets/
│       └── navio-kb-testing-final-response-v2.json # 60-example test dataset
├── lib/                           # Central libraries
│   ├── langsmith.ts               # LangSmith EU client, span filtering, metadata
│   ├── llm.ts                     # Azure OpenAI chat model resolver
│   ├── load-env.ts                # Local environment variable loader (.env.local)
│   └── eval/                      # Evaluation engine
│       ├── dataset-upload.ts      # Dataset upload helper
│       ├── evaluators.ts         # Deterministic & regex evaluators
│       ├── judges.ts              # LLM-as-a-Judge evaluators (8 quality metrics)
│       ├── metrics.ts             # Metric aggregation utilities
│       └── rate-limit.ts          # Azure TPM token-bucket rate limiter
├── scripts/                       # CLI Execution Scripts
│   ├── live-check.ts              # Agent sanity & response verification script
│   ├── run-eval.ts                # Benchmark evaluation suite runner
│   ├── upload-eval-dataset.ts     # Upload dataset to LangSmith script
│   ├── verify-eval-dataset.ts     # Local dataset schema validation script
│   └── verify-langsmith.ts        # LangSmith API & tracing verification script
├── src/
│   └── internal/
│       └── authored-module-map-loader.ts # Module loader helper
├── system_prompt_optimization/    # Prompt Research & Candidates
│   ├── README.md                  # Benchmark summary & version matrix
│   ├── analysis/                  # TRACE_EVIDENCE.md (60-sample benchmark data)
│   ├── baseline/                  # Production system prompt baseline
│   └── versions/                  # Standalone candidate prompts (v1–v4)
└── tests/                         # Vitest Test Suite
    ├── agent.test.ts              # Agent configuration & tool sentinel tests
    ├── eval-rate-limit.test.ts    # Rate limiter unit tests
    └── langsmith.test.ts          # LangSmith client & span filtering tests
```

---

## 4. System Prompt Design (`agent/instructions.md`)

The system prompt controls all agent behavior and is divided into 5 major sections:

1. **`=== IDENTITY ===`**: Establishes persona ("Navio 👋🏻"), brand voice ("Sportnavi"), Du-form tonality, friendly warmth, target audience depth levels, and language-matching rules.
2. **`=== KNOWLEDGE BASE ===`**: Contains complete embedded Sportnavi documentation (`doc2.md`, `doc3.md`, `doc4.md`, `doc5.md`) covering FAQs, Partner terms, Employer packages, Member rules, and Cashback procedures.
3. **`=== BEHAVIOR RULES ===`**: Enforces strict knowledge boundaries, proactive guiding without hallucination, 3-audience depth adjustments (Members, Companies, Partners), prohibition of guessing non-KB prices/terms, and handling unavailable capabilities (e.g. appointment booking).
4. **`=== CONVERSATIONAL INTELLIGENCE ===`**: Instructs intent reading over literal wording, emotional signal adaptation (frustrated, confused, loophole-seeking users), and structured 4-step answers for complex queries.
5. **`=== HARD LIMITS (NIEMALS VERLETZEN) ===`**: Enforces anti-prompt-injection security, sensitive data (IBAN/ID) blocking, zero hallucination, anti-roleplaying, max word length (<400 words), and strict markdown rendering constraints.

---

## 5. Development Workflow & Commands

### Prerequisites & Setup
Ensure `.env.local` exists in `kb-agent-langsmith-starter/` with required credentials:
```bash
AZURE_AI_CHATBOT_API_KEY=<key>
AZURE_AI_CHATBOT_ENDPOINT=<endpoint>
AZURE_AI_CHATBOT_DEPLOYMENT_NAME=<deployment>
LANGSMITH_API_KEY=<langsmith-key>
LANGSMITH_PROJECT=kb-agent-langsmith-starter
LANGSMITH_RECORD_IO=true
```

### Essential CLI Commands
Run commands inside `kb-agent-langsmith-starter`:

| Command | Purpose |
|---|---|
| `npm run dev` | Launch agent server via `eve dev` |
| `npm run dev:ui` | Launch Next.js Dev Console at `http://localhost:3000` |
| `npm run typecheck` | Run TypeScript type validation (`tsc --noEmit`) |
| `npm test` | Run test suite with Vitest (`vitest run`) |
| `npm run live-check` | Run live sanity check query against agent |
| `npm run eval:verify` | Validate local dataset schema (`navio-kb-testing-final-response-v2.json`) |
| `npm run eval:upload` | Upload evaluation dataset to LangSmith EU |
| `npm run eval:run` | Execute 60-example benchmark evaluation suite |

---

## 6. Available Integrations & MCP Capabilities

### LangSmith MCP Server Integration
* **Config Location:** `.mcp.json` in workspace root.
* **Server Name:** `langsmith`
* **Target Endpoint:** `https://eu.api.smith.langchain.com`
* **Capabilities:** Query traces, list runs, inspect datasets, upload evaluation results, and monitor experiments directly via MCP tools.

---

## 7. Installed Claude Skills Analysis

The project environment includes 10 Claude Skills located in `.claude/skills/`:

### LangSmith & Observability Skills
1. **`langsmith-dataset`** (`.claude/skills/langsmith-dataset`)
   * **Purpose:** Create, export, upload, and manage LangSmith evaluation datasets.
   * **When to use:** When creating new benchmark datasets or uploading JSON test cases to LangSmith.
2. **`langsmith-evaluator`** (`.claude/skills/langsmith-evaluator`)
   * **Purpose:** Build custom offline/online evaluators, LLM-as-a-Judge pipelines, and run functions.
   * **When to use:** When extending the evaluation metrics or writing new automated judges.
3. **`langsmith-trace`** (`.claude/skills/langsmith-trace`)
   * **Purpose:** Configure application tracing and query trace data from LangSmith.
   * **When to use:** When debugging agent executions, analyzing latency, or tracing step outputs.

### Design, UI & Presentation Skills
4. **`ui-ux-pro-max`** (`.claude/skills/ui-ux-pro-max`): Local UI/UX intelligence database (84 styles, 192 color palettes, 74 font pairings) across 22 stacks.
5. **`ui-styling`** (`.claude/skills/ui-styling`): Component styling guidelines for `shadcn/ui`, Radix, and Tailwind CSS v4.
6. **`design-system`** (`.claude/skills/design-system`): Token architecture (primitive→semantic→component) and UI component specifications.
7. **`design`** (`.claude/skills/design`): Unified design skill for brand identity, CIP mockups, social photos, icons, and logos.
8. **`brand`** (`.claude/skills/brand`): Brand messaging consistency, voice guidelines, and visual identity standards.
9. **`slides`** (`.claude/skills/slides`): HTML presentation creation using Chart.js and structured copywriting.
10. **`banner-design`** (`.claude/skills/banner-design`): Multi-format banner generation for web, ads, and social media.

---

## 8. Installed Plugins Analysis

The project settings in `.claude/settings.json` define the following plugins:

1. **`context7@claude-plugins-official`** (Status: `Enabled`)
   * **Purpose:** Context and documentation retrieval for developer libraries and frameworks.
   * **Application:** Use when referencing library specifications or verifying API documentation.
2. **`playwright@claude-plugins-official`** (Status: `Enabled`)
   * **Purpose:** End-to-end browser automation, UI testing, and visual testing.
   * **Application:** Use for automated testing of the Next.js Dev Console (`http://localhost:3000`).
3. **`sentry@claude-plugins-official`** & **`sentry-cli@claude-plugins-official`** (Status: `Disabled`)
   * **Purpose:** Sentry error monitoring and CLI commands.

---

## 9. Important Implementation Details & Findings

* **Eve Built-in Tool Disabling:** Eve framework automatically enables default tools unless explicitly overridden. Disabling tools requires placing `export default disableTool();` files under `agent/tools/<tool_name>.ts`.
* **Span Filter Ancestor Tracking:** LangSmith drops spans if parent spans are omitted. `AiSpanFilter` (`agent/instrumentation.ts`) tracks and exports all ancestor workflow spans.
* **Token Bucket Rate Limiting:** Azure OpenAI TPM (Tokens Per Minute) limits are handled in `lib/eval/rate-limit.ts` using a sliding-window token bucket to prevent `429 Too Many Requests` during evaluations.
* **System Prompt Optimization:** The `system_prompt_optimization/` workspace tracks 4 benchmark-tested candidate prompts (v1 deduplication, v2 contradiction fix, v3 language reinforcement, v4 output brevity) ready for review.

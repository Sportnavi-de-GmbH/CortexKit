# ONBOARDING.md — CortexKit / Navio

> **Read this first.** A fast on-ramp for any agent or developer joining this repo.
> For exhaustive detail, see [CLAUDE.md](CLAUDE.md); for deep topics, see [docs/](docs/).
> This file is the "start here" — it tells you what the project is, how it's wired,
> and how to be productive without re-investigating everything.

---

## 1. What this project is (in one paragraph)

CortexKit hosts **Navio** — the public, anonymous customer-support chatbot for
**Sportnavi** (sportnavi.de), a German corporate-fitness network. Navio is built on the
**eve** agent framework (Vercel) and answers questions from members, companies, and
partners using **only a knowledge base baked into its system prompt** — no RAG, no tools,
no runtime retrieval. The repo also serves as the reference implementation for a large
**LangSmith (EU) observability + evaluation** stack. Everything lives in
[`kb-agent-langsmith-starter/`](kb-agent-langsmith-starter/).

**The prompt is the product.** To change Navio's behavior you edit
[`agent/instructions.md`](kb-agent-langsmith-starter/agent/instructions.md) — not code.

---

## 2. The five things to know before you touch anything

1. **No tools by design.** Navio has no tools, subagents, or skills. eve's 11 built-in
   tools are each explicitly disabled via `disableTool()` sentinels in
   [`agent/tools/`](kb-agent-langsmith-starter/agent/tools/). Disabling `web_search` is
   intentional — it would let the model answer from outside the curated KB.
2. **The KB is embedded in the prompt**, between the `=== KNOWLEDGE BASE ===` and
   `=== BEHAVIOR RULES ===` markers of `agent/instructions.md`. Five FAQ documents
   (German + English). Editing behavior = editing this file. No code change needed.
3. **LangSmith is EU-region and no-op without a key.** A fresh clone runs credential-free.
   Never point at the US default. **Hooks never throw.** Content capture is off unless
   `LANGSMITH_RECORD_IO=true`.
4. **One request = one trace.** This relies on a deterministic OTLP span-id → run-id
   mapping plus a file-backed anchor store that bridges eve's separately-bundled
   instrumentation and hook modules.
5. **It's a public, anonymous, login-less widget.** Security is defense-in-depth
   (origin allowlist, BotID, edge rate limits, AI-Gateway spend cap), not one gate. See
   [`agent/channels/eve.ts`](kb-agent-langsmith-starter/agent/channels/eve.ts).

---

## 3. Runtime shape (how a request flows)

```
Visitor on sportnavi.de
  → Navio widget (iframe, same-origin) → /eve/v1/session
      → channel auth gate (agent/channels/eve.ts): BotID → origin allowlist → localDev
      → eve agent (agent/agent.ts, NO tools)
          → Azure OpenAI (gpt-4.1) with the ~41.5k-token system prompt as `instructions`
          → streamed reply
  → OTLP spans → LangSmith EU   (agent/instrumentation.ts)
  → hook runs  → LangSmith EU   (agent/hooks/langsmith.ts)  ← per-turn summary + failures
```

Alongside the agent there's a **Next.js app** (dev chat console + the public widget +
a Salesforce-backed contact form). Hook runs land in LangSmith in **seconds**, OTLP spans
in **minutes**.

---

## 4. Map of the code (what lives where)

All paths are inside [`kb-agent-langsmith-starter/`](kb-agent-langsmith-starter/).

| Path | What it is |
|---|---|
| `agent/agent.ts` | Agent definition — no tools/subagents/skills. Lazily resolves the model. |
| `agent/instructions.md` | **THE SYSTEM PROMPT** (persona + KB + rules), ~41.5k tokens. Edit this to change behavior. |
| `agent/kb/kb.md` | Standalone *copy* of just the KB docs (reference only — editing it does nothing). |
| `agent/tools/*.ts` | 11 `disableTool()` sentinels (the "no tools" guarantee). |
| `agent/channels/eve.ts` | Public HTTP API auth policy (anonymous widget, fail-closed, origin/bot gates). |
| `agent/instrumentation.ts` | OTLP traces → LangSmith EU; span filtering + renaming; publishes trace anchor. |
| `agent/hooks/langsmith.ts` | The only path from an agent failure to LangSmith. Per-turn summary + failure runs. |
| `agent/feedback/` | Tester feedback + prompt iterations (`FEEDBACK-ANALYSIS.md`, `SYSTEM_PROMPT_V3.md`). |
| `lib/langsmith.ts` | Single source of truth for all LangSmith decisions (region, gate, spans, runs). |
| `lib/llm.ts` | Azure OpenAI model resolver (throws a clear error naming any missing env var). |
| `lib/eval/` | Eval pipeline: `evaluators.ts` (deterministic), `judges.ts` (8 LLM-judges), `metrics.ts`, `dataset-upload.ts`, `rate-limit.ts`. |
| `lib/contact/` | Salesforce contact form: `salesforce.ts` (OAuth + flow call), `schema.ts` (zod). |
| `app/` + `components/` | Next.js dev console, `app/widget/` (public widget), `app/api/contact/` (contact endpoint). |
| `public/launcher.js` | The embeddable widget launcher script. |
| `scripts/` | `run-eval.ts`, `live-check.ts`, `cache-check.ts`, `contact-live-check.ts`, dataset upload/verify, `verify-langsmith.ts`. |
| `evals/datasets/*.json` | Eval datasets (source of truth — LangSmith EU has been known to drop them). |
| `tests/` | Vitest: agent smoke test, LangSmith unit tests, rate-limit tests. |
| `src/internal/authored-module-map-loader.ts` | Required **Windows** eve dev-host shim (without it, session create fails). |

**When searching, exclude** `.eve/`, `.next/`, `.output/`, `node_modules/` — they hold
duplicate dev-host snapshots. Only the top-level source paths are authoritative.

---

## 5. Where the documentation lives

- **[docs/](docs/)** — numbered long-form docs `01`–`11` (objective, challenges,
  architecture, prompt engineering, experiment analysis, KB strategy, team workflow,
  feedback loop, website security, operations, roadmap) + `docs/reference/`.
- **[docs/deployment/](kb-agent-langsmith-starter/docs/deployment/)** — `PUBLIC-WIDGET-DEPLOYMENT.md`,
  `VERCEL-RUNBOOK.md`, `VERCEL-DASHBOARD-GUIDE.md`.
- **[docs/design/](kb-agent-langsmith-starter/docs/design/)** — widget specs + `WIDGET-DESIGN-GUIDELINES.md`
  (brand green `#95c11e`, Outfit + Inter fonts).
- **[docs/decisions/](kb-agent-langsmith-starter/docs/decisions/)** — `OBSERVABILITY-DECISION.md`.
- **[docs/reference/EVE_LANGSMITH_TRACING_GUIDE.md](docs/reference/EVE_LANGSMITH_TRACING_GUIDE.md)** —
  the ~92 KB guide this repo is the worked example of.

---

## 6. How to run it

All commands run inside `kb-agent-langsmith-starter/`.

```bash
npm install
cp .env.example .env.local     # fill in Azure vars; the rest are optional
npm run dev                    # eve dev server — NOTE THE REAL PORT it prints
npm run dev:ui                 # Next.js dev console (chat UI + agent together)
npm run typecheck              # tsc --noEmit — must exit 0
npm test                       # vitest: smoke + langsmith + rate-limit
npx eve info                   # lists the agent, confirms disabled tools (expect 0 errors)
```

**Baseline first:** get typecheck, smoke test, `eve info`, and a live turn working
*before* touching the LangSmith integration — so an integration bug can't be mistaken for
a broken agent.

**Environment variables** (`.env.example` lists them all as placeholders):
- **Required to actually talk to the model:** `AZURE_AI_CHATBOT_OPENAI_ENDPOINT`,
  `AZURE_AI_CHATBOT_API_KEY`, `AZURE_AI_CHATBOT_DEPLOYMENT_NAME` (default deployment `gpt-4.1`).
  Missing → agent degrades to the `openai/gpt-4.1` gateway id so the module stays importable.
- **LangSmith (optional):** `LANGSMITH_API_KEY`, `LANGSMITH_PROJECT`, `LANGSMITH_TRACING`,
  `LANGSMITH_ENDPOINT` (EU!), `LANGSMITH_RECORD_IO`.
- **Widget/security:** `WIDGET_ALLOWED_ORIGINS`, `WIDGET_FRAME_ANCESTORS`, `BOTID_ENABLED`.
- **Contact form (Salesforce):** `SALESFORCE_*`, `CONTACT_RATE_LIMIT_PER_MIN`, `CONTACT_FALLBACK_EMAIL`.

Never commit `.env.local` or any real key.

---

## 7. The eval pipeline (in brief)

Two-phase runner (`scripts/run-eval.ts`), so rate-limit waits never pollute trace latency:
- **Phase A (execute)** — serial, paced loop calls the agent per example (no spans).
- **Phase B (evaluate)** — `evaluate()` replays records into clean, priced traces and runs
  the judges. The ~41.5k-token prompt replays every call, so **TPM is the binding limit**.

Deterministic evaluators are free (`mustInclude`, `languageMatch`, `conciseness`, …);
8 LLM-as-judge evaluators (`judges.ts`) share the Azure deployment at temperature 0.
**Safety policy:** a platform-blocked adversarial turn counts as a *pass*.
Datasets live in `evals/datasets/*.json` and are re-uploaded automatically (LangSmith EU
has dropped them before — the repo JSON is authoritative).

---

## 8. Capabilities available in this repo

- **LangSmith MCP** (EU) — prefer it for reading traces/datasets/experiments.
- **Skills** — `langsmith-trace`, `langsmith-dataset`, `langsmith-evaluator` are core here;
  design skills exist but aren't part of the agent runtime.
- **Plugins** — `context7` (dependency docs), `playwright` (QA the dev console).
- **superpowers** — process skills (brainstorming, systematic-debugging, TDD). Start
  behavior/feature changes with brainstorming; start bugs with systematic-debugging.

---

## 9. House rules (do / don't)

**Do**
- Edit `agent/instructions.md` to change behavior; validate via the eval loop.
- Keep the LangSmith stack **EU-only**, **no-op-without-a-key**, **hooks-never-throw**.
- Keep content capture off by default (`LANGSMITH_RECORD_IO`).

**Don't**
- Rewrite or "improve" the system prompt unless explicitly asked — it encodes product/brand
  decisions and a documented feedback history.
- Add tools/RAG to the agent — the no-tool design is deliberate.
- Point anything at the US LangSmith endpoint or commit secrets.

---

## 10. Known open items / gotchas

- **Prompt V3 is written but NOT deployed.** `agent/feedback/SYSTEM_PROMPT_V3.md` (shorter)
  is a candidate; the live prompt is still the long version in `instructions.md`. Deploying
  = replacing `instructions.md`, then re-running evals.
- **Known KB factual errors are unfixed.** `agent/feedback/FEEDBACK-ANALYSIS.md` documents
  9 issues, several of which are faithful renditions of wrong KB facts.
- **Secrets in `.mcp.json`.** A LangSmith and a Stitch key are committed in plaintext —
  contradicts the "never commit keys" rule. Flagged for rotation.
- **Windows quirk.** The `authored-module-map-loader.ts` shim is required for the eve
  dev-host on Windows; without it `POST /eve/v1/session` fails with `ERR_MODULE_NOT_FOUND`.
- **CLAUDE.md may lag reality** — it predates the git history, the public widget, the
  contact form, and the committed eval datasets. When they disagree, trust the code and
  this file, then update CLAUDE.md.

---

## 11. First-hour checklist for a new agent

1. Read this file, then skim [CLAUDE.md](CLAUDE.md) §2–§6 for depth.
2. `npm install` → `npm run typecheck` → `npm test` (all green with no keys).
3. `npx eve info` — confirm the agent loads and 11 tools are disabled.
4. Open `agent/instructions.md` and read the section markers (`=== IDENTITY ===`,
   `=== KNOWLEDGE BASE ===`, `=== BEHAVIOR RULES ===`, `=== HARD LIMITS ===`).
5. Before any behavior change: invoke **superpowers:brainstorming**; drive changes through
   the feedback → eval loop, never ad hoc.

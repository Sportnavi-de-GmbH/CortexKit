# KB Agent — LangSmith Starter (Documentation Testbed)

A **minimal, clean eve agent** built as the testbed for
[`EVE_LANGSMITH_TRACING_GUIDE.md`](../../EVE_LANGSMITH_TRACING_GUIDE.md)
(repo root).

**Status: the guide has been followed to completion in this folder**
(2026-07-27 validation run — every §14 checkbox confirmed live against
LangSmith EU). It now contains the full integration and serves as the guide's
primary reference implementation: `lib/langsmith.ts`,
`agent/instrumentation.ts`, `agent/hooks/langsmith.ts`,
`tests/langsmith.test.ts`, and `scripts/verify-langsmith.ts`. The minimal
sibling reference (without Part D system-prompt capture) is
`example/langsmith-observability-agent/`.

To redo the guide from scratch as an exercise, delete the files listed in
"What the guide adds" below and work through the guide again.

## What's here (and why)

| Path | Purpose |
|---|---|
| `agent/agent.ts` | The agent definition. No tools, no subagents, no skills — behaviour comes entirely from the system prompt. |
| `agent/instructions.md` | **Your system prompt goes here.** Replace the placeholder content with your own prompt / knowledge base — no code changes needed. |
| `agent/tools/*.ts` | `disableTool()` sentinels, one per eve built-in tool (bash, web_search, read_file, …). "No tools" takes work: eve ships built-ins unless each is disabled, and `web_search` would give the model a source of truth outside your prompt. |
| `lib/llm.ts` | Azure OpenAI model resolver (clear error naming any missing env var). |
| `lib/load-env.ts` | Loads `.env.local` for scripts run outside the eve runtime. Import it first in every script. |
| `scripts/live-check.ts` | Sends one real turn to the local eve dev server and prints the session id — the tool used by the guide's verification steps (§11 V3). |
| `app/` + `components/` | The dev chat console. `SessionBar` shows status, the copyable session id, and cumulative token usage. (No LangSmith feedback bar — feedback capture belongs to a future guide.) |
| `next.config.mjs` | `withEve({})` — lets `next dev` host the console alongside the agent. |
| `src/internal/authored-module-map-loader.ts` | Windows workaround for eve@0.25.3 dev-host module resolution (same shim as the other examples). Without it, `POST /eve/v1/session` fails with ERR_MODULE_NOT_FOUND. |
| `tests/agent.test.ts` | Baseline smoke test so `npm test` is meaningful from step zero. |
| `tests/langsmith.test.ts` | The guide's Part B checkpoint tests: failure-payload shapes, the never-throw guard, no-key no-op, span-filter tree logic, EU URLs, anchors, system-prompt store. |
| `.env.example` | Every env var the guide uses, as placeholders. Copy to `.env.local`. |
| `evals/datasets/*.json` | Versioned LangSmith evaluation datasets (source of truth; Stage 1 = 5-sample `smoke` split). Design rationale: [`docs/LANGSMITH-DATASET-GUIDE.md`](docs/LANGSMITH-DATASET-GUIDE.md). |
| `scripts/upload-eval-dataset.ts` | Uploads a dataset file to LangSmith EU and verifies it (`npm run eval:upload`). Refuses to overwrite an uploaded version — bump `vN` instead. |

## What the guide adds (now present — created on the 2026-07-27 validation run)

| File | Guide section |
|---|---|
| `lib/langsmith.ts` — EU constant, client factory, gates, metadata, span filter state, trace anchors + file stores, turn journal, failure payloads, human span names | Part A (A1+A3), Parts B–D, §9 |
| `agent/instrumentation.ts` — OTLP span export to LangSmith EU, span filter, runtime context, anchor publishing, system-prompt capture | Part A (A2–A4), Parts C–D |
| `agent/hooks/langsmith.ts` — failure capture + turn summary runs (the trace root) | Parts B–C |
| `tests/langsmith.test.ts` — the checkpoint unit tests | Part B checkpoint |
| `scripts/verify-langsmith.ts` — API-based verification | §11, Step V4 |

## Step 0 — Baseline: prove the testbed works BEFORE integrating anything

```bash
cd example/kb-agent-langsmith-starter
npm install
cp .env.example .env.local        # fill in the Azure vars (LangSmith vars can wait)
npm run typecheck                 # exit 0
npm test                          # smoke test green
npx eve info                      # 0 errors; the disabled tools are listed
npm run dev                       # note the REAL port from "server listening at http://127.0.0.1:<port>"
```

Or start the **dev console** instead (chat UI + agent in one command):

```bash
npm run dev:ui                    # Next.js console at http://localhost:3000 (or the next free port)
```

Open the printed URL and chat with the agent. The session id shown in the top
bar (`sid: …`, click to copy) is what you'll later paste into the guide's
verification script to find the matching LangSmith trace.

Then, in a second terminal:

```bash
EVE_HOST=http://127.0.0.1:<port> npm run live-check -- "What can you help me with?"
```

You should get a reply driven by whatever is in `agent/instructions.md`.
(The printed status may read `status=waiting` on eve 0.25.3 even though the
reply is complete — judge by the message text.) **Do not start the guide until
this baseline works** — otherwise you can't tell an integration bug from a
broken agent.

## Then follow the guide

Work through the guide **in order**, doing every step in this folder:

1. **§4 Environment Setup** — fill in the LangSmith vars in `.env.local` (EU endpoint!), install `langsmith @vercel/otel @opentelemetry/sdk-trace-base`.
2. **§5 Part A** — create `lib/langsmith.ts` and `agent/instrumentation.ts`. Checkpoint after each step (typecheck → `eve info` → `eve build`).
3. **§6 Part B** — create `agent/hooks/langsmith.ts` and its tests.
4. **§7 Part C** — trace anchors (one trace per request).
5. **§8 Part D** — system-prompt capture + cost rules.
6. **§11 Verification** — one clean turn, one failing turn, verify via the API. Remember: hook runs appear in **seconds**, OTLP spans in **minutes**.
7. **§14 Final checklist** — every box, then you're done.

Note on failing-turn verification: this agent has no tools, so the guide's
tool-failure test doesn't apply as-is. Either verify failure capture with the
`turn.failed` path (e.g. temporarily point `AZURE_AI_CHATBOT_DEPLOYMENT_NAME`
at a nonexistent deployment for one turn), or temporarily add the guide's
`calculate_division` demo tool (copy from
`../langsmith-observability-agent/agent/tools/calculate_division.ts`) while
testing Part B and remove it afterwards — that is how the 2026-07-27
validation run did it. ⚠️ When you do, the prompt must **explicitly demand the
tool call** ("Call the calculate_division tool with a=1 and b=0 …") — asked
plainly to "divide 1 by 0", the model answers from its own knowledge without
calling the tool, and no failure ever happens (guide §11 V3).

## Ground rules while working in this folder

- **EU endpoint everywhere** — every LangSmith URL derives from the single constant you create in Step A1. Never the US default.
- **No key = no-op** — the agent must keep running with an empty `.env.local`.
- **Hooks never throw** — guard every handler; a thrown hook becomes `turn.failed`.
- **Never commit `.env.local` or any real API key** — placeholders only in committed files.

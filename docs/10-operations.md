# 10. Operations and Maintenance

## In plain terms

This is the practical runbook: how to set up the project, run it, test it, run
experiments safely, manage prompt versions, and fix common problems. If you're a
new developer, start here after reading the architecture ([03](03-solution-architecture.md)).

## 10.1 Prerequisites

- Node.js 18+.
- An **Azure OpenAI** deployment (model `gpt-4.1`).
- (Optional) a **LangSmith** account (EU) for tracing/evaluation. Without it, the
  agent still runs; observability just no-ops.

## 10.2 Local setup

From `kb-agent-langsmith-starter/`:
```bash
npm install
cp .env.example .env.local        # fill in the Azure vars
npm run typecheck                 # must exit 0
npm test                          # smoke + unit tests green
npm run dev                       # eve dev server — NOTE the printed port
# or the chat console:
npm run dev:ui                    # Next.js UI at http://localhost:3000
```
Send a real turn (second terminal, use the REAL port):
```bash
EVE_HOST=http://127.0.0.1:<port> npm run live-check -- "Was ist Sportnavi?"
```

## 10.3 Environment variables (`.env.local` — never commit)

```bash
# Model (required to answer)
AZURE_AI_CHATBOT_OPENAI_ENDPOINT=
AZURE_AI_CHATBOT_API_KEY=
AZURE_AI_CHATBOT_DEPLOYMENT_NAME=gpt-4.1
# LangSmith (optional; missing key = observability no-ops)
LANGSMITH_API_KEY=
LANGSMITH_PROJECT=Navio KB Chatbot
LANGSMITH_TRACING=true
LANGSMITH_ENDPOINT=https://eu.api.smith.langchain.com   # EU — never the US default
LANGSMITH_RECORD_IO=false        # true = ship prompts/answers to LangSmith
# LANGSMITH_WORKSPACE_ID=        # only if your key is org-scoped
```
Ground rules: **EU endpoint everywhere**, **no key = no-op**, **hooks never
throw**, **never commit `.env.local` or a real key**.

## 10.4 npm scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start the eve dev server (prints the real port) |
| `npm run dev:ui` | Start the Next.js chat console |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest: agent smoke + LangSmith unit + rate-limit tests |
| `npm run live-check -- "…"` | Send one real turn (needs `EVE_HOST`) |
| `npm run eval:upload` | Upload a dataset to LangSmith (immutable; bump `vN` to change) |
| `npm run eval:verify` | Confirm the remote dataset matches the local file |
| `npm run eval:dev` | **Fast** eval: 10 curated samples, 2 judges (~6 min) |
| `npm run eval:run` | **Full** eval: 60 samples, 7 judges (~35 min) |

## 10.5 Testing workflow

1. `npm run typecheck && npm test` — must be green before anything else.
2. `npm run eval:dev` — fast quality/cost/latency signal on a change.
3. `npm run eval:run` — full confirmation before promoting a prompt.

## 10.6 Experiment workflow (safe A/B)

The key discipline: **never edit the production prompt to test.**
1. Save the candidate under `system_prompt_optimization/versions/<name>/system_prompt.txt`.
2. **Back up** the current `agent/instructions.md`, then copy the candidate over it.
3. **Verify** the server is serving the candidate — `eve dev` hot-reloads the
   file, so check the trace's captured system prompt / input-token count matches
   the candidate (this is how we catch the "wrong prompt served" trap).
4. Run `npm run eval:dev` (or `run`) with a **new, descriptive**
   `EVAL_EXPERIMENT_PREFIX` so you never overwrite a previous experiment.
5. Compare in LangSmith's compare view.
6. **Restore** `agent/instructions.md` to the original.

Only one variable changes (the prompt); dataset, judges, model, config stay
identical.

## 10.7 Prompt version management

- Candidates live in `system_prompt_optimization/versions/` (v1…v6), each with its
  own `system_prompt.txt` + `analysis_report.md`.
- The verified original is preserved in `system_prompt_optimization/baseline/`.
- **Current recommended prompt:** **v6** (smallest, best-scoring, fixes the pause
  bug) — pending a human fact-check of its corrections and a clean full-60
  confirmation before production promotion.
- Put the repo **under git** so versions and experiments are properly tracked
  (not yet done — see [11](11-future-roadmap.md)).

## 10.8 Knowledge base updates

Change behavior/facts by editing `agent/instructions.md` (no code change). For
KB *content* from the team, follow the handoff in
[07-internal-team-workflow.md](07-internal-team-workflow.md): fold verified
answers into the KB (or the corrections block), add a benchmark test, evaluate,
promote on pass.

## 10.9 Monitoring

- **Eval:** LangSmith experiments give per-sample quality, cost, tokens, and true
  latency; rate-limit behavior is reported separately.
- **Production (planned):** online evaluators + cost/latency/error alerts on live
  traffic ([08](08-feedback-improvement-process.md), [11](11-future-roadmap.md)).

## 10.10 Troubleshooting (real issues we hit)

| Symptom | Likely cause | Fix |
|---|---|---|
| Prompt change has no effect / tokens unchanged | The server is serving a **different/stale** agent copy (e.g. another project on the same port) | Confirm the eve server is rooted in this repo; check the served-prompt token count/hash; restart on a clean port if needed |
| Latency wildly high / benign questions failing | Two eve servers sharing one Azure deployment (contention) | Ensure only one server runs against the deployment; re-run for clean latency |
| `429 Monthly unique traces usage limit exceeded` | LangSmith monthly trace quota exhausted | Iterate on `eval:dev` (fewer traces); upgrade plan or wait for reset for full runs |
| Agent won't start (`ERR_MODULE_NOT_FOUND` on Windows) | Known dev-host module-resolution issue | The repo ships a Windows shim (`src/internal/authored-module-map-loader.ts`); ensure it's present |
| `status=waiting` but a reply is present | eve 0.25.x display quirk | Judge by the message text, not the status |
| Eval fails at `resolveData` | Dataset not uploaded / wrong name | `npm run eval:upload` the dataset; check `EVAL_DATASET` |

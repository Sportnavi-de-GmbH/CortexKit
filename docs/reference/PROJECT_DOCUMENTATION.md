# Navio — Sportnavi Support Chatbot: Complete Project Documentation

> A guide for the next developer. This is not just "what we built" — it's the
> **journey**: the problems we hit, the alternatives we weighed, and *why* each
> decision was made. Read the Executive Summary if you're non-technical; read
> the rest if you'll be maintaining or extending it.
>
> Companion doc: [`CLAUDE.md`](CLAUDE.md) at the repo root is the terse
> architecture reference. This document is the narrative and the reasoning.

---

## Executive Summary (for everyone)

**Navio** is the AI support chatbot for **Sportnavi**, a German corporate-fitness
network. It answers questions from three audiences — members, companies, and
partner studios — in a warm, informal German (or the user's language).

The whole product is a **single, carefully engineered system prompt**. There is
no database lookup at answer time: the entire Sportnavi FAQ is written *into* the
prompt, and the model answers from it. That design choice — "prompt, not
retrieval" — is the core of the project and is explained in Section 4.

Our work fell into three phases:
1. **Observability** — wire the agent to LangSmith so we can see cost, latency,
   tokens, and quality on every answer.
2. **Evaluation** — build a 60-question benchmark and a scoring pipeline so we
   can measure prompt changes objectively instead of by gut feel.
3. **Optimization** — use that measurement to iterate the system prompt from a
   baseline through six versions (v1–v6), fixing real factual errors testers
   found, cutting cost/tokens, and cleaning up the structure.

The current best prompt is **v6**, which is smaller, cheaper, better-structured,
and — uniquely — fixes a factual bug about membership pauses that survived five
earlier attempts. Along the way we also built a **fast evaluation tier** (10
curated samples, ~6 min) so iterating no longer means waiting 35 minutes, and a
**knowledge-gap backlog** (Excel) so the Sportnavi team can keep enriching the
knowledge base.

**Business impact:** more accurate answers (fewer wrong facts told to real
customers), lower cost per answer (~29% cheaper), and a repeatable, measurable
process for improving the bot instead of guessing.

---

## 1. Project Overview

### The problem
Sportnavi's support team fields the same questions thousands of times:
memberships, tariffs, cancellation, pauses, cashback, the app, check-ins,
corporate fitness. Answering them by hand is slow and doesn't scale. They needed
a chatbot that gives **accurate, on-brand, 24/7 answers** — and, crucially, one
that **does not make things up**, because a support bot that invents a price or a
cancellation rule creates real customer harm.

### Why this solution was needed
Two things were non-negotiable:
- **Factual accuracy bounded by a known knowledge base.** The bot must answer
  *only* from Sportnavi's curated FAQ, and honestly say "I don't know, contact
  support" when something isn't covered.
- **Brand voice.** Sportnavi's tone is a warm, informal German "du," lightly
  playful, never robotic. Generic chatbots don't do this out of the box.

### Who the users are
- **Members / employees** — how to use Sportnavi, the app, check-in, billing.
- **Companies** — how corporate fitness (Firmenfitness) works, benefits, setup.
- **Partner studios** — how to become a partner, the portal, payouts.

Navio adapts its *depth* per audience while keeping the same warm tone.

### The final goal
A reliable, measurable, continuously-improvable support agent that (a) answers
correctly within its knowledge, (b) refuses gracefully outside it, (c) resists
manipulation (prompt injection, jailbreaks), and (d) can be improved with
evidence, not opinion.

### Challenges before this work
- No way to **see** what the bot was doing (no tracing, cost, or latency
  visibility).
- No way to **measure** whether a prompt change helped or hurt.
- The knowledge base contained **known factual errors** (testers had flagged
  them) with no systematic way to fix or track them.
- Every experiment was **slow and manual**, so iteration was painful.

---

## 2. Development Journey (step by step)

This is the honest account, including the wrong turns — they're the most
instructive part.

### 2.1 Starting point: a working but "blind" agent
The agent already existed: an [eve](https://www.npmjs.com/package/eve) agent
named Navio whose behavior comes entirely from `agent/instructions.md` (~20k
tokens, 89% of which is the embedded Sportnavi knowledge base). It had **no
tools** — deliberately (Section 4). But it was a black box: we couldn't see cost,
latency, or quality per answer.

**Decision:** before changing *anything* about the prompt, make the agent
observable. You can't optimize what you can't measure.

### 2.2 Phase 1 — Observability (LangSmith)
We integrated LangSmith (EU region, for data residency). The tricky part: eve
emits telemetry as OpenTelemetry (OTLP) spans and emits *failures* as stream
events, not exceptions. So we needed two paths:
- **Traces** via an OTLP exporter (`agent/instrumentation.ts`) — the full call
  tree, token usage, model spans.
- **Failure + summary runs** via a hook (`agent/hooks/langsmith.ts`) — because a
  blocked/failed turn never throws, the only way to capture it is a guarded hook.

**Key decision — "one request = one trace":** raw OTLP traces are noisy and the
root span carries no business context ("No inputs / No outputs"). We built a
*trace anchor* mechanism so the human-readable summary run (what the user asked,
what the bot replied, tokens, cost, outcome) *becomes* the trace root. This is
why LangSmith shows clean, readable traces instead of framework noise. (Full
rationale is documented inline in `lib/langsmith.ts`.)

**Hard rule we adopted:** *observability must never break the agent.* Every hook
is guarded; with no API key the entire LangSmith layer no-ops and the agent runs
credential-free.

### 2.3 Phase 2 — Evaluation (the benchmark)
Observability tells you what happened; it doesn't tell you if a change is
*better*. So we built:
- A **60-question dataset** (`navio-kb-testing-final-response-v2`) covering FAQs,
  edge cases, multilingual, and a full security suite (prompt injection,
  jailbreaks, extraction, adversarial input).
- A **two-phase evaluation runner** (`scripts/run-eval.ts`):
  - **Phase A (execute):** a serial, rate-limit-paced loop calls the real agent
    for each question and records the answer + true latency + tokens.
  - **Phase B (evaluate):** replays those records into clean traces and runs the
    scorers — deterministic checks (language match, must-include, conciseness)
    plus **7 LLM-as-judge** metrics (hallucination, correctness, relevance,
    perceived error, tone, user satisfaction, knowledge retention).

**Why two phases?** Because rate-limit waiting would otherwise pollute the
latency numbers. By pacing in Phase A *before* the latency clock starts, and
replaying the measured duration in Phase B, the reported latency is **true model
time**, not "time spent waiting for our own throttle." This was a deliberate,
important design decision — the user explicitly needed latency that excludes
throttling.

### 2.4 Phase 3 — Optimization (v1 → v6)
With measurement in place, we could finally iterate with evidence. We generated
candidate prompts, each targeting one thing:
- **v1 — Deduplication.** We discovered the KB embedded the *same* FAQ twice
  (doc1 and doc2 were 73% word-identical; doc1 added zero unique topics but
  ~3,900 tokens). Removing doc1 cut ~17% of the prompt with no quality loss.
- **v2 — Fix a documented contradiction.** Testers had flagged that the KB
  contradicts itself on whether pause months can be split. v2 patched a
  cheat-sheet line.
- **v3 — Language reminder.** Some English questions got German answers; v3
  added a reminder near the end of the prompt.
- **v4 — Brevity default.** Set a ~100–150 word target for simple answers.
- **v5 — Combined.** Stacked v1–v4 plus a "verified corrections" block
  implementing all six tester-corrected facts.
- **v6 — Re-architecture.** Explained below.

### 2.5 The problems we hit (and what they taught us)
This is the part a journey doc must be honest about:

- **The "wrong server" bug.** Early experiments silently ran against a *different
  project's* copy of the agent (a stale `eve dev` server from
  `AdvancedMemorySystem` on the same port). We only caught it because the token
  count didn't drop after deduplication. **Lesson:** always verify the running
  agent is serving the prompt you think it is. We now check the served
  prompt's token count / hash before trusting a run.
- **Cross-run contention.** Two `eve dev` servers sharing one Azure deployment
  caused latency spikes and made benign questions fail — contaminating a full-60
  run. **Lesson:** isolate the eval environment; a clean latency comparison
  requires a quiet Azure deployment.
- **v2's fix didn't work.** The empirical run proved v2 (and even v5) *still*
  failed the pause-split question. Root cause: the word "flexibel" survived in
  the *main* KB text (doc2/doc4), not just the cheat-sheet we edited. **This is
  the single best argument for measuring instead of assuming** — we'd have
  shipped a "fix" that fixed nothing.
- **35-minute iterations were killing us.** Every full benchmark took ~35 min.
- **LangSmith monthly trace quota.** Running many experiments in one day
  exhausted the account's monthly trace allowance, blocking the final full-60
  confirmation. **Lesson:** traces are a budget; use the cheap tier for
  iteration.

### 2.6 How we reached the final architecture
Two responses to those problems shaped the final state:
1. **A fast evaluation tier.** We built `npm run eval:dev` — a **10-sample
   curated subset** (including the known "regression guards") that runs in ~6 min
   instead of 35, and reserves the full 60 for final sign-off. This made
   iteration affordable in both time and trace-budget.
2. **v6, a ground-up re-architecture** rather than another patch. Using the
   6-way comparison data, we kept only what *measurably* helped (dedup,
   corrections), dropped what didn't (the redundant reminder block, verbose
   brevity), fixed the pause bug **at the root** (removed "flexibel" from the KB
   *and* added an explicit override), added real ambiguity handling, and
   reorganized everything into a clean 9-section structure. v6 is the smallest,
   best-scoring version and the only one that actually fixes the pause bug.

---

## 3. Technology Stack

| Layer | Technology | Why |
|---|---|---|
| Agent runtime | **eve** (`^0.25.2`) | Filesystem-first agent framework; the whole agent is `agent/instructions.md` + config. No orchestration code to maintain. |
| Model | **Azure OpenAI `gpt-4.1`** | Frontier quality + EU/enterprise data handling; the deployment is resolved in `lib/llm.ts`. Falls back to a gateway id so the module imports with no secrets. |
| Model SDK | **AI SDK (`ai` ^7)** + `@ai-sdk/openai` | eve's model layer; provides the telemetry spans LangSmith consumes. |
| Observability | **LangSmith (EU)** + `@vercel/otel` + OpenTelemetry SDK | Tracing, experiments, cost/latency; EU endpoint for data residency. |
| Dev console | **Next.js 15 + React 19 + Tailwind 4** | Local chat UI (`app/` + `components/`) hosted alongside the agent via `withEve({})`. |
| Language/tooling | **TypeScript 5.9**, **tsx** (run TS directly), **Vitest** (tests), **dotenv** | Standard TS toolchain. |
| KB-gap tooling | **Python + openpyxl** | Only used offline to generate the internal-team Excel files. |

### How components communicate
```
Next.js console  ─┐
CLI (live-check) ─┼─►  eve dev server  ─►  Azure OpenAI (gpt-4.1)
eval runner      ─┘         │
                            ├─► OTLP spans      ─►  LangSmith EU (traces)
                            └─► hook runs       ─►  LangSmith EU (summary/failure)
```
The agent has **no tools**, so there are no external tool calls at answer time —
the only outbound call is to Azure OpenAI. Trace/observability writes to
LangSmith are best-effort and never block the answer.

### Running it locally
Prerequisites: Node 18+ and an Azure OpenAI deployment. From
`kb-agent-langsmith-starter/`:
```bash
npm install
cp .env.example .env.local        # fill in the Azure vars (LangSmith optional)
npm run typecheck                 # must exit 0
npm test                          # smoke + unit tests
npm run dev                       # eve dev server — NOTE the printed port
# or:
npm run dev:ui                    # Next.js chat console at http://localhost:3000
```
Then, in a second terminal, send a real turn:
```bash
EVE_HOST=http://127.0.0.1:<port> npm run live-check -- "Was ist Sportnavi?"
```

### Required environment variables (`.env.local`, never committed)
```bash
# Model (required to answer)
AZURE_AI_CHATBOT_OPENAI_ENDPOINT=
AZURE_AI_CHATBOT_API_KEY=
AZURE_AI_CHATBOT_DEPLOYMENT_NAME=gpt-4.1
# LangSmith (optional; missing key = observability no-ops, agent still runs)
LANGSMITH_API_KEY=
LANGSMITH_PROJECT=Navio KB Chatbot
LANGSMITH_TRACING=true
LANGSMITH_ENDPOINT=https://eu.api.smith.langchain.com   # EU — never the US default
LANGSMITH_RECORD_IO=false        # true = ship prompts/answers to LangSmith
# LANGSMITH_WORKSPACE_ID=        # only if your key is org-scoped
```

### Development / testing / deployment workflow
- **Change behavior** → edit `agent/instructions.md` (no code change needed).
- **Test fast** → `npm run eval:dev` (10 samples, ~6 min).
- **Confirm** → `npm run eval:run` (full 60, ~35 min).
- **Unit tests** → `npm test` (agent smoke, LangSmith unit tests, rate-limit tests).
- **Deployment** → the agent is an eve app; `next.config.mjs` uses `withEve({})`
  so it can be hosted with Next.js. (This repo is the dev/eval harness; the
  production hosting target is eve's runtime.) **Note:** this folder is currently
  *not* a git repository — version control is a recommended next step.

---

## 4. AI Architecture Decisions

### The central choice: prompt injection, not RAG
The entire knowledge base lives **inside the system prompt**. The model is not
given a retrieval tool; it answers from the ~16–20k tokens of FAQ text baked into
`instructions.md`. Here's the reasoning.

**Why prompt-embedded KB was the right first choice:**
- **The KB is small and bounded.** Sportnavi's FAQ is ~16k tokens — it fits
  comfortably in a modern context window. RAG exists to handle knowledge that's
  *too big* to fit; ours isn't.
- **Perfect recall, zero retrieval risk.** With the whole KB in context, the
  model never "misses" a relevant chunk because a retriever ranked it low. There
  is no retrieval step to get wrong.
- **Simplicity.** No vector store, no embedding pipeline, no chunking strategy,
  no retriever to tune, no extra infrastructure to run and pay for. The agent has
  **no tools at all** — which also removes a whole class of failure and a whole
  attack surface.
- **Prompt caching makes it cheap.** Azure caches the stable ~16k-token prefix,
  so repeated calls are billed mostly at the cached rate. In practice ~99% of the
  prompt is a cache read.

**The limitations we accepted (honestly):**
- **Throughput ceiling.** The big prompt is re-sent every turn, so tokens-per-
  minute (TPM), not requests-per-minute, is the binding constraint. At ~20k
  tokens/turn against a 50k TPM budget, that's ~2 turns/minute. Caching lowers
  *cost* but not *TPM consumption*. This is the main scaling limit today.
- **Edit-and-verify overhead.** Changing a fact means editing prose, and you must
  re-run evals to confirm — versus RAG where you'd update a document.
- **Contradictions bite hard.** If the same fact appears twice in the KB with
  different wording, the model can pick the wrong one (this is exactly the
  pause-split bug). With everything in context, internal consistency matters a
  lot.

### "No tools" is deliberate and enforced
eve ships built-in tools (web_search, bash, read_file, …) unless each is
disabled. `agent/tools/` contains 11 `disableTool()` sentinels — one per built-in
— specifically so the model *cannot* reach outside the curated prompt.
`web_search`, in particular, would give it a source of truth we don't control and
undermine the "answer only from the KB" guarantee.

### When RAG becomes the right move
Switch to (or add) retrieval when **any** of these becomes true:
- The KB grows past what's economical to send every turn (say, > ~30–40k tokens),
  making TPM/cost prohibitive.
- Content becomes highly dynamic (live prices, per-partner data, real-time
  availability) — better fetched than baked in.
- You need per-user or per-region personalization that shouldn't be in a shared
  prompt.
- You want citations/source-linking in answers.
A sensible future hybrid: keep the small, stable "persona + rules + core facts"
in the prompt, and retrieve only the large/dynamic parts (partner catalog,
current prices) via a tool.

---

## 5. EVE Agent Integration

### How eve works here
eve is a **filesystem-first** agent framework: the agent *is* its folder. There's
almost no orchestration code — `agent/agent.ts` is ~30 lines that (a) load env,
(b) resolve the Azure model, and (c) `defineAgent({...})`. Everything the agent
*does* comes from `agent/instructions.md` (the system prompt) plus the disabled
tools.

### The end-to-end request flow
```
User ─► Application (Next.js console / CLI / eval client)
     ─► eve dev server (POST /eve/v1/session)
     ─► Agent (agent.ts): assembles system prompt = instructions.md
     ─► Azure OpenAI gpt-4.1 (prompt = KB+rules as `instructions`, + user message)
     ─► streamed answer back to the user
     ─► (in parallel, best-effort) OTLP spans + hook summary run ─► LangSmith EU
```
**Step by step:**
1. **User → Application.** A message arrives via the Next.js chat console, the
   `live-check` CLI, or the eval client (`eve/client`).
2. **Application → eve server.** The app opens a session and sends the turn.
3. **eve → Agent.** eve loads `instructions.md` as the system prompt (it passes
   it to the model as a separate `instructions` parameter — which is why our
   instrumentation captures it explicitly for the trace).
4. **Agent → Model.** Azure gpt-4.1 receives [system prompt = persona + KB +
   rules] + [user message]. No tools are offered.
5. **Model → Response.** The model answers from the KB; the reply streams back.
6. **Observability.** OTLP spans and the hook's summary run are written to
   LangSmith (guarded, never blocking).

### How the system prompt controls behavior
The prompt is the product. Its structure (as of v6) is nine ordered sections:
role → core rules → answer quality → fact accuracy → business-critical
corrections → KB usage → language → ambiguity handling → efficiency, plus a
security/anti-injection block. Ordering matters: high-priority "corrections" sit
just before the KB (so they override it), and the language/ambiguity/security
rules sit *after* the KB for recency (the model attends to them right before it
answers).

### How prompt changes are tested
A critical operational detail we learned: **`eve dev` hot-reloads
`instructions.md`** — swap the file and the next turn uses the new prompt (verify
via the trace's captured system prompt / token count). So the test loop is:
swap candidate → confirm it's being served → `npm run eval:dev` → compare in
LangSmith → restore the original. We never edit the *production* prompt to test;
we swap a candidate into a local copy and restore afterward.

---

## 6. System Prompt Engineering Process

### How we analyzed the original
We measured the prompt objectively first: it's ~21k tokens, and **89.3% of it is
the knowledge base**. That single fact drove strategy — the only big levers for
cost/throughput are in the KB; the instruction wrapper (~2.3k tokens) is where
quality/behavior lives. We also ran the baseline through the full benchmark to
get a quality floor (hallucination 0.97, correctness 0.94, language 0.92).

### How versions were created (and what each proved)
| Version | Change | What the data showed |
|---|---|---|
| v1 | Remove duplicate KB doc | −17% tokens, quality unchanged → keep |
| v2 | Patch pause cheat-sheet line | **No effect** — sample-028 still failed |
| v3 | Add language reminder | No reliable effect (mirroring is partly stochastic) |
| v4 | Brevity default | No score change (conciseness ceiling never bound) |
| v5 | Combine v1–v4 + corrections block | Best-of-first-five; fixed the price anchor; still failed pause-028 |
| **v6** | Re-architect + root pause fix + ambiguity | **Best quality, smallest, and finally fixes pause-028** |

### How LangSmith compared versions
Each candidate ran as its own experiment against the *same* dataset and
evaluators, with a descriptive name (e.g.
`cmp-v6-dev10-20260729`). LangSmith's compare view then shows them side by side.
The rule we followed for a fair A/B: **change exactly one variable (the prompt)**;
keep dataset, judges, model, and config identical.

### What makes a good system prompt (our takeaways)
- **Every instruction must earn its tokens.** We *removed* v3's reminder block
  and v4's verbose text because the data showed no measurable benefit. "Sounds
  good" is not a reason to keep an instruction.
- **Put authoritative overrides where the model will see them.** The "verified
  corrections" block sits before the KB and explicitly says it wins on conflict.
- **Recency matters.** Language/ambiguity/security rules go *after* the KB.
- **Fix contradictions at the source.** You cannot instruct your way out of a KB
  that states a wrong fact in its main text — you must edit the text *and* add the
  override. That's the lesson of pause-028.

### How hallucinations were reduced
- An explicit **"never invent an undocumented number/date/price/rule"** rule.
- A **business-corrections block** that hard-codes the six facts testers found
  the bot getting wrong.
- Grounding reference answers on the *actual* KB in evals, so the hallucination
  judge measures real drift.

### How quality and efficiency improved
Net result at v6 vs baseline (10-sample tier): hallucination 70→90%+, correctness
72→92%, tokens −16%, cost ~−29% per answer, with the pause bug fixed — while the
prompt got *smaller and cleaner*.

---

## 7. LangSmith Integration and Evaluation

### Why LangSmith
We needed tracing, experiment comparison, and cost/latency in one place, with an
**EU** data-residency option and native OpenTelemetry ingestion (so we could feed
it eve's existing spans without bolting on a second SDK). LangSmith fit.

### How it connects
- **Traces:** `agent/instrumentation.ts` registers an OTLP exporter pointed at
  LangSmith EU's `/otel/v1/traces`, filtered so only meaningful (AI) spans and
  their ancestors are sent.
- **Summary + failure runs:** `agent/hooks/langsmith.ts` writes one readable
  "Customer Request" run per turn (and dedicated failure runs), using the trace
  anchor so it becomes the trace root.
- **Central module:** `lib/langsmith.ts` owns every LangSmith decision (region,
  client, gates, span filter, run payloads). Both entry points are thin consumers.

### Evaluation workflow
```
npm run eval:upload   # push the dataset to LangSmith (immutable; bump vN to change)
npm run eval:verify   # confirm the remote dataset matches the local file
npm run eval:dev      # fast: 10 curated samples, 2 judges (~6 min)  ← iterate here
npm run eval:run      # full: 60 samples, 7 judges (~35 min)         ← final sign-off
```

### Metrics captured (per sample and aggregated)
- **Quality (LLM judges):** hallucination, correctness, answer_relevance,
  perceived_error, tone, user_satisfaction, knowledge_retention.
- **Deterministic:** language match, must-include / must-not-include anchors,
  conciseness.
- **Cost/observability:** input/output/cache tokens, cost (cache-aware), and
  **true model latency** (excluding rate-limit waiting — see Section 2.3).

### Cost / token / latency tracking
Cost is computed from token usage at configured Azure prices and cross-checked
against LangSmith's native cost. Every trace carries per-turn tokens and latency,
so you can slice by sample, category, or difficulty. The runner also reports
Azure rate-limit behavior (retries, throttling) **separately** from latency, so
throttling never contaminates the performance numbers.

### Tuning knobs (all env vars on `run-eval.ts`)
`EVAL_DATASET`, `EVAL_SPLIT`, `EVAL_LIMIT`, `EVAL_JUDGES`, `EVAL_CONCURRENCY`,
`EVAL_TPM_BUDGET`, `EVAL_TOKENS_PER_REQUEST`, `EVAL_EXPERIMENT_PREFIX`, `EVE_HOST`.
The pacing is TPM-bound and self-imposed (safe by default); raise `EVAL_TPM_BUDGET`
only if your real Azure quota is higher.

---

## 8. Knowledge Base Improvement Process

### How missing information was identified
Three evidence streams:
1. **Tester feedback** (`feedback/*.docx`, analyzed in
   `agent/feedback/FEEDBACK-ANALYSIS.md`) — nine concrete issues, six of which
   are the KB stating a *wrong* fact (pause usage, cashback multi-tickets,
   employer notice period, cancellation channel, referral timing, one Firmenfitness
   model).
2. **Eval failures** — LangSmith experiments surfaced the exact samples where the
   bot hallucinated or answered wrong (the pause bug, exact-price traps,
   language mirroring).
3. **The official Sportnavi website** — fetched live and diffed against the KB,
   which revealed *new* gaps: real tariff prices (49,90 / 74,90 / 139,90 €), a
   support-hours conflict (site 8:30 vs KB 9:00), and check-in-frequency wording
   that disagrees with the KB.

### The Excel workflow (for the Sportnavi team)
We deliberately produced **simple, two-column** spreadsheets (in
`knowledge_base_improvement/`) — not a complex metadata system — because the team's
job is just: *read the question, write/validate the correct answer*.
- `kb_questions_to_answer.xlsx` — 59 realistic questions across all topics,
  including the known wrong-answer traps.
- `kb_edge_cases_blindspots.xlsx` — 51 **new** edge cases not covered anywhere
  (legal Widerrufsrecht, life events, Firmenfitness special cases, check-in
  failures, tax/insurance, ambiguous one-liners, follow-ups, competitor
  comparisons).
- `kb_gap_backlog.csv` — the richer, prioritized backlog with sources/status for
  planning.

**Purpose:** find missing questions → add better answers → expand coverage →
handle hard scenarios. **Discipline built into the files:** where there is no
official rule, the answer is left `TBD — confirm internally`, *never* invented —
because inventing answers is exactly how hallucinations start.

---

## 9. Internal Team Workflow (how to keep improving it)

1. **Review failures.** In LangSmith, open the latest experiment and filter by
   low scores or failed turns. Read the judge's reasoning — it tells you *why* a
   sample failed. Separate genuine failures from expected security blocks (those
   are "safety passes").
2. **Add missing knowledge.** Take answered rows from the Excel files and fold
   the confirmed facts into the KB (or the v6 "corrections" block for facts that
   contradict existing KB wording). Confirm tester-sourced facts with the
   business owner first; keep prices/legal figures current.
3. **Create new test cases.** For every new/fixed fact, add a sample to the
   dataset (question + reference answer + must-include anchors). Bump the dataset
   version (`vN`) — uploaded versions are immutable by convention.
4. **Evaluate a new prompt version safely.** Save it as a new candidate under
   `system_prompt_optimization/versions/`, **swap it into a local copy** of
   `instructions.md`, verify the server is serving it, run `npm run eval:dev`,
   compare in LangSmith, then **restore the original**. Never edit production to
   test.
5. **Run experiments safely.** Use `eval:dev` for iteration (cheap on time *and*
   LangSmith trace quota); reserve `eval:run` for final confirmation. Make sure
   only one eve server is running and it's rooted in this project.

---

## 10. Lessons Learned and Future Improvements

### What worked well
- **Measure before you change.** The two-phase eval + benchmark turned prompt
  work from guesswork into engineering. It repeatedly caught "fixes" that didn't
  fix anything (v2/v5 pause bug).
- **Prompt-embedded KB** gave us perfect recall, simplicity, and — thanks to
  caching — low cost, exactly right for a small bounded KB.
- **The fast dev-10 tier** made iteration ~6× faster and preserved trace budget.
- **Evidence-driven pruning** (v6) produced a prompt that's *smaller and better*
  by removing instructions that didn't earn their keep.

### Challenges discovered
- **Environment isolation is critical** — the wrong-server bug and cross-run
  contention both came from shared/duplicated infrastructure. Clean numbers need
  a clean environment.
- **TPM is the throughput ceiling** of the prompt-embedded approach.
- **Trace quota is a real budget** — a day of full-60 runs can exhaust it.
- **Language mirroring is only partly promptable** — it has a stochastic
  component we couldn't fully eliminate with instructions.

### What to improve next
- **Version control.** This folder isn't a git repo yet — put it under git so
  prompt versions and experiments are properly tracked.
- **Finish the v6 full-60 confirmation** once LangSmith trace quota is available,
  then (after a human fact-check of the six corrections) promote v6 to production.
- **A dedicated cheaper judge model.** Judges run on gpt-4.1 today; a smaller
  judge deployment would cut ~40% of eval cost.
- **Pre-flight guard.** A script that hashes the served prompt and confirms a
  single correct server *before* a run — would have prevented the wrong-server
  incident.
- **Automated regression tests.** Turn each answered Excel question into an eval
  sample so the benchmark grows with the KB, and wire `eval:dev` into CI.

### Possible future enhancements
- **Hybrid RAG** if the KB grows or needs live data (prices, partner catalog):
  keep persona+rules+core facts in the prompt, retrieve the big/dynamic parts.
- **Production monitoring** — online evaluators on live traffic (not just offline
  experiments) to catch drift in the wild.
- **Multi-platform integration** — WhatsApp/web-widget/Slack front ends over the
  same eve agent.
- **Feedback loop** — capture thumbs-up/down in production and feed low-rated
  turns straight into the KB-gap backlog.

---

### Appendix — where things live
```
kb-agent-langsmith-starter/
├── agent/instructions.md              # THE system prompt (production)
├── agent/agent.ts / tools/*           # agent definition + 11 disableTool sentinels
├── agent/instrumentation.ts, hooks/   # LangSmith traces + summary/failure runs
├── lib/langsmith.ts, llm.ts           # central observability + Azure model resolver
├── lib/eval/*                         # evaluators, judges, metrics, rate-limit
├── scripts/run-eval.ts, eval-dev.ts   # full + fast evaluation runners
├── evals/datasets/*.json              # 60-sample benchmark + 10-sample dev subset
├── system_prompt_optimization/        # baseline + v1..v6 candidates + reports
└── knowledge_base_improvement/        # the team's KB-gap Excel/CSV backlog
```
Start with [`CLAUDE.md`](CLAUDE.md) for the terse architecture map, then this
document for the reasoning.

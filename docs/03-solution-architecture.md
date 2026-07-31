# 3. Solution Architecture

## In plain terms

The chatbot is intentionally simple at its core: a message goes to an **agent**,
the agent hands the model a **system prompt with the whole knowledge base inside
it**, and the model answers. There's no database query at answer time. Around
that core sit two supporting systems: **observability** (so we can see cost,
speed, and quality) and, for production, a **security layer** in front of the
public website widget.

> **Current vs planned.** What exists in this repo today: the eve agent, the
> system prompt + embedded KB, the LangSmith observability + evaluation, and a
> local dev chat console. What is **PLANNED / in progress**: the production
> website widget, the Vercel-hosted public endpoint, and the bot-protection +
> rate-limiting security layer (`botid` was just added to the stack). Those are
> described here as the target architecture and detailed in
> [09-website-security.md](09-website-security.md).

## The complete request flow (target)

```
User
  ↓
Sportnavi Website Chatbot Widget        (PLANNED — public, anonymous)
  ↓
Secure Backend / API Layer              (PLANNED — Vercel; BotID, rate limit, secrets)
  ↓
Vercel EVE Agent                        (the agent runtime)
  ↓
System Prompt + Knowledge Base          (agent/instructions.md — the product)
  ↓
Azure OpenAI (gpt-4.1)
  ↓
AI Response  ──► streamed back to the user
  │
  └► (in parallel, best-effort) OTLP traces + summary/failure runs ──► LangSmith EU
```

## Components — what each is and why it exists

### 1. Website chatbot widget (PLANNED)
A small embeddable widget on the public Sportnavi site. Anonymous, no login. It
sends the visitor's message to the secure backend and renders the streamed reply.
*Why:* meet users where they already are, with zero friction.

### 2. Secure backend / API layer (PLANNED)
A thin server (on Vercel) between the public widget and the agent. It:
- keeps **API keys/secrets server-side** (never in the browser),
- applies **bot detection** (Vercel **BotID** — `botid` dependency) and **rate
  limiting** to stop abuse of a public, unauthenticated endpoint,
- enforces a **cost/budget guardrail**.
*Why:* a public LLM endpoint is a spend-and-abuse target; it must never expose
credentials or allow unbounded calls. See [09](09-website-security.md).

### 3. Vercel EVE agent (CURRENT)
The [eve](https://www.npmjs.com/package/eve) agent runtime. eve is
**filesystem-first**: the agent *is* its folder. `agent/agent.ts` is ~30 lines —
it loads env, resolves the Azure model (`lib/llm.ts`), and calls
`defineAgent({...})`. It has **no tools** (11 `disableTool()` sentinels in
`agent/tools/`), so at answer time the *only* external call is to Azure OpenAI.
*Why no tools:* it removes an entire failure surface and attack surface, and
guarantees the bot can't fetch a "truth" outside the curated KB.

### 4. System prompt (CURRENT — the product)
`agent/instructions.md` is the whole product. It contains the persona, the
behavior rules, the business-critical fact corrections, and the full knowledge
base, organized (as of version v6) into a clean nine-section structure. Changing
behavior means editing this file — no code change. *Why:* maximal control and
fast iteration for a bounded knowledge domain (rationale in
[04](04-system-prompt-engineering.md)).

### 5. Knowledge base (CURRENT)
~16k tokens of Sportnavi FAQ embedded inside the prompt (≈89% of the prompt's
size). ~90% of it was collected from **public Sportnavi sources** (see
[06](06-knowledge-base-strategy.md)). *Why embedded, not retrieved:* the KB is
small enough to fit in context, giving perfect recall with no retrieval step to
get wrong.

### 6. LangSmith tracing and evaluation (CURRENT)
Two write paths to LangSmith (EU region):
- **Traces** — `agent/instrumentation.ts` exports OpenTelemetry (OTLP) spans (the
  call tree, tokens, model spans), filtered to meaningful spans.
- **Summary + failure runs** — `agent/hooks/langsmith.ts` writes one readable
  "Customer Request" run per turn (and dedicated failure runs), because the
  runtime emits failures as events, not exceptions.
A central module (`lib/langsmith.ts`) owns every LangSmith decision. *Why:* you
cannot improve what you can't see; this is how we get per-answer cost, latency,
tokens, and quality. Detail in [05](05-experiment-analysis.md).

### 7. Security layers (in-prompt CURRENT; network PLANNED)
- **In-prompt** (current): an anti-injection / no-roleplay / no-sensitive-data /
  no-hallucination block that makes the model refuse manipulation and never leak
  its instructions.
- **Network** (planned): BotID, rate limiting, secret isolation, budget caps.

### 8. Monitoring and cost control (CURRENT for eval; PLANNED for prod)
Every trace carries tokens, cache reads, computed cost, and true model latency.
The evaluation runner reports Azure rate-limit behavior separately from latency.
*Why:* an LLM product's running cost is real and must be watched per answer, per
experiment, and (in production) per budget window.

## How the pieces communicate (today)

```
Next.js dev console  ─┐
CLI (live-check)     ─┼─►  eve dev server  ─►  Azure OpenAI (gpt-4.1)
Evaluation runner    ─┘         │
                                ├─► OTLP spans  ─►  LangSmith EU
                                └─► hook runs   ─►  LangSmith EU
```

The observability writes are **best-effort and never block** the answer — with no
LangSmith key, that whole layer no-ops and the agent still runs.

## Deployment model

- **Today:** this repository is the **agent + evaluation harness**. You run the
  eve dev server locally (`npm run dev`) or the Next.js console (`npm run
  dev:ui`). Setup in [10-operations.md](10-operations.md).
- **Target:** the eve agent deployed behind the Vercel secure API layer, with the
  widget embedded on the Sportnavi website. `next.config.mjs` uses `withEve({})`
  so the agent can be hosted alongside a Next.js app.
- **Note:** the project folder is **not yet under git** — putting it under version
  control is a recommended near-term step (see [11](11-future-roadmap.md)).

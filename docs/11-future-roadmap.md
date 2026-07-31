# 11. Future Roadmap

## In plain terms

Today the chatbot is prompt engineering + a curated knowledge base + evaluation.
That's the right architecture for now, but it has a ceiling. This document lays
out how it evolves — most importantly, toward a **RAG** (retrieval) architecture
as the knowledge grows — plus the nearer-term improvements that make the system
more robust and cheaper to operate.

## 11.1 The expected evolution

**Current phase**
```
System Prompt Engineering
        +
Curated Knowledge Base (embedded in the prompt)
        +
LangSmith Evaluation
```

**Future phase**
```
System Prompt            (persona + rules + core stable facts)
        +
Knowledge Base
        +
RAG Retrieval            (large/dynamic content fetched on demand)
        +
Advanced AI Platform     (monitoring, online eval, multi-channel, auth)
```

## 11.2 RAG integration (the big one)

**Why / when.** The prompt-embedded KB works because the KB is small (~16k
tokens) and stable. RAG becomes necessary when **any** of these holds:
- The KB grows past what's economical to send every turn (~30–40k+ tokens) —
  cost, latency, and the TPM throughput ceiling all worsen.
- Content becomes **dynamic** — live tariff prices, per-partner availability,
  region-specific data — better fetched than baked in.
- You need **citations** (link the answer to a source page) or **per-user**
  answers.

**How it improves things.** Retrieval sends the model only the *relevant* slice of
a large corpus, so the knowledge can scale to thousands of documents without
inflating every request. It also lets non-developers update knowledge by editing
documents rather than prose in a prompt.

**How we prepare now.** Keep the *stable* persona/rules/core-facts cleanly
separable from the *bulky/dynamic* knowledge (v6's structure already does this),
so retrieval can later feed just the latter — a **hybrid**: small prompt + RAG for
the rest. The evaluation harness carries straight over (same datasets, same
judges) to measure RAG vs the current approach objectively.

## 11.3 Nearer-term improvements

- **Version control.** Put the project under git — prompt versions, datasets, and
  experiments should be tracked properly.
- **Finish the v6 confirmation & promote.** Run the clean full-60 (once LangSmith
  quota allows), human-check the six fact corrections, then promote v6 to
  production.
- **Cheaper judge model.** LLM judges run on gpt-4.1 today; a smaller judge
  deployment would cut ~40% of evaluation cost with negligible quality loss.
- **Pre-flight guard.** A script that hashes the served prompt and confirms a
  single, correct eve server *before* a run — would have prevented the
  wrong-server and contention incidents.
- **Automated regression testing.** Turn each answered team-Excel question into a
  benchmark sample so the test set grows with the KB, and wire `eval:dev` into CI
  so every prompt change is auto-evaluated.
- **Isolated eval environment.** A dedicated Azure deployment for evaluation so
  live/dev traffic never contaminates latency measurements.

## 11.4 Better evaluation pipelines

- **Online evaluation** on a sample of live production traffic (not just offline
  benchmarks) to catch drift in the wild.
- **Repetitions** on key metrics (run each sample N times, look at the rate) to
  remove single-sample noise.
- **A standing "regression guard" set** — the known-hard samples — tracked across
  every version.

## 11.5 Production monitoring

- **Cost/latency/error alerting** on live traffic, with budget caps.
- **Thumbs-up/down** capture in the widget feeding the feedback loop
  ([08](08-feedback-improvement-process.md)).
- **Anomaly detection** — spikes in refusals, failures, or cost.

## 11.6 Platform & product expansion

- **Multi-channel front ends** — WhatsApp, Slack, a web widget, or a mobile app —
  all over the *same* eve agent, so behavior stays consistent.
- **API access** — expose the agent to partner systems.
- **Authentication + personalization** — once the bot needs to answer
  account-specific questions (a member's billing, a company's contract), add auth
  and combine with RAG over the authenticated user's data (see
  [09](09-website-security.md)).
- **Additional AI agents / enterprise features** — e.g. a partner-facing agent, a
  sales-assist agent, or internal tools — reusing the same evaluation and
  knowledge discipline established here.

## 11.7 The through-line

Whatever gets built next, the operating principle stays the same and is the real
asset of this project: **improve with evidence, not opinion.** Every change —
prompt, KB, or a future RAG layer — is measured on the benchmark before it ships,
and the knowledge base grows only with *verified* facts. That discipline is what
lets the system scale from a curated-prompt chatbot today into a reliable,
RAG-backed AI platform tomorrow without losing the trust that makes a support bot
worth having.

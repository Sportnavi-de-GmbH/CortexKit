# Navio (Sportnavi Support Chatbot) — Project Documentation

This is the complete knowledge source for the project. It's written for two
audiences at once:

- **Non-technical stakeholders** — read the "In plain terms" opening of each file
  for the value, the decisions, and the direction.
- **Developers** — the rest of each file has the implementation detail and the
  *reasoning* behind every choice.

We deliberately document the **journey**, not just the final state: the problems
we hit, the alternatives we weighed, and why we chose what we chose.

## How to read this

| # | File | What it answers |
|---|---|---|
| 1 | [01-project-objective.md](01-project-objective.md) | Why does this project exist? Who is it for? What's the vision? |
| 2 | [02-challenges.md](02-challenges.md) | What problems made a dedicated AI chatbot necessary? |
| 3 | [03-solution-architecture.md](03-solution-architecture.md) | What are the components and how does a request flow through them? |
| 4 | [04-system-prompt-engineering.md](04-system-prompt-engineering.md) | How AI behavior is controlled; why prompt engineering, not RAG (yet). |
| 5 | [05-experiment-analysis.md](05-experiment-analysis.md) | How we measure quality/cost/latency and compare prompt versions. |
| 6 | [06-knowledge-base-strategy.md](06-knowledge-base-strategy.md) | Where the knowledge came from (~90% public) and how it improves. |
| 7 | [07-internal-team-workflow.md](07-internal-team-workflow.md) | How the internal team extends the knowledge base (the Excel workflow). |
| 8 | [08-feedback-improvement-process.md](08-feedback-improvement-process.md) | How feedback becomes knowledge improvements. |
| 9 | [09-website-security.md](09-website-security.md) | How the public, anonymous chatbot is exposed safely. |
| 10 | [10-operations.md](10-operations.md) | Run it locally, test, run experiments, manage prompt versions, monitor. |
| 11 | [11-future-roadmap.md](11-future-roadmap.md) | Where this goes next — including the path to RAG. |

## The one-paragraph version

**Navio** is Sportnavi's AI support chatbot. Its entire behavior is a single,
carefully engineered **system prompt** with the Sportnavi FAQ embedded directly
inside it (no database lookup at answer time). We built **observability**
(LangSmith tracing of cost/latency/tokens) and a **60-question evaluation
benchmark** so we can improve the prompt with evidence instead of guesswork, then
iterated it through six versions to fix real factual errors, cut cost ~29%, and
reduce hallucinations. The knowledge base — ~90% sourced from public Sportnavi
material — keeps improving through a simple team workflow and a feedback loop.
Today it's prompt-engineering + curated KB + evaluation; the roadmap evolves it
toward a hybrid **RAG** platform as the knowledge grows.

## A note on "current" vs "planned"

Where a document describes something not yet built (e.g. the production website
widget, the bot-protection and rate-limiting layer, RAG), it is labelled
**PLANNED** or **TARGET**. Everything else describes what exists in this
repository today. Related terse reference: [`../CLAUDE.md`](../CLAUDE.md).

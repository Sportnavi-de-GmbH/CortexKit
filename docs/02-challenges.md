# 2. Challenges and Problems Identified

## In plain terms

Before we could make the chatbot *better*, we had to confront why it wasn't
reliable enough yet. The problems fell into three buckets: **AI behavior** (it
could make things up), **process** (we couldn't measure or improve it
systematically), and **infrastructure** (we couldn't even see what it was
doing). This document is the honest catalog — each of these directly shaped the
solution.

## 2.1 AI-related challenges

These are the reasons a generic LLM isn't enough on its own:

- **Hallucinations.** An unconstrained model happily invents a price, a deadline,
  or a policy. For a support bot, that's a direct customer-trust risk. *Example we
  measured:* asked for an exact tariff price the KB didn't contain, the bot made
  one up instead of deferring.
- **Incorrect answers from a flawed knowledge base.** Some errors weren't the
  model's fault — the knowledge base itself stated wrong facts. Testers flagged
  six: pause usage ("not usable" — actually using an offer *cancels* the pause),
  cashback multi-tickets, employer notice periods, the cancellation channel, the
  referral payout timing, and a non-existent "Firmenfitness model" concept. A
  faithful bot repeats a wrong KB *faithfully*.
- **Missing information.** Many real questions had no KB answer at all (exact
  prices, the 14-day right of withdrawal, what happens if you move abroad), so the
  bot either deferred or, worse, guessed.
- **Inconsistent responses.** The same fact appearing twice in the KB with
  different wording (e.g. whether pause months can be "split flexibly") let the
  model pick the wrong one seemingly at random.
- **Language drift.** English questions sometimes got German answers, especially
  on refusals and edge cases.
- **Security exposure.** A public bot invites prompt injection, jailbreak
  attempts, and system-prompt extraction — it must refuse these reliably.

## 2.2 Maintaining business knowledge is hard

The knowledge lives as prose inside a large prompt. That makes it:
- **Easy to contradict yourself** — the pause-splitting bug is the canonical
  example; a single stray word ("flexibel") in the main text overrode an explicit
  correction elsewhere.
- **Manual to update** — changing a fact means editing text and re-verifying.
- **Hard to know what's missing** — nothing tells you a topic is uncovered until a
  user hits it.

## 2.3 Process challenges (the biggest blocker)

- **No measurement.** There was no objective way to answer "did this prompt change
  make the bot better or worse?" Decisions were opinion-based.
- **Slow iteration.** A full evaluation took ~35 minutes, so trying ideas was
  expensive and rare.
- **No regression safety.** Fixing one thing could silently break another with no
  alarm.

## 2.4 Technical / infrastructure challenges

- **The agent was "blind."** No tracing — we couldn't see per-answer cost, token
  usage, or latency.
- **Failures were invisible.** The runtime reports failures as data events, not
  exceptions, so a blocked or failed turn left no trace unless we captured it
  deliberately.
- **Environment fragility.** During the work we discovered experiments could
  silently run against the *wrong* copy of the agent, and that two agent instances
  sharing one model deployment corrupted latency measurements. Reliable evaluation
  needs a controlled environment.
- **Throughput ceiling.** Because the whole knowledge base is re-sent on every
  turn (~20k tokens), tokens-per-minute — not request count — is the binding
  limit, capping throughput.

## Why these required a *dedicated* AI chatbot solution

You cannot solve "reliably correct, honest, on-brand, measurable, secure" by
dropping in a generic chatbot. Each challenge above maps to a deliberate part of
our solution:

| Challenge | Solution (see) |
|---|---|
| Hallucination / wrong facts | Bounded prompt-embedded KB + explicit corrections + "never invent" rule ([04](04-system-prompt-engineering.md)) |
| Can't measure | LangSmith tracing + a 60-question benchmark + LLM-judge scoring ([05](05-experiment-analysis.md)) |
| Slow iteration | A fast 10-sample evaluation tier ([05](05-experiment-analysis.md), [10](10-operations.md)) |
| Missing knowledge | Public-source collection + a team enrichment workflow ([06](06-knowledge-base-strategy.md), [07](07-internal-team-workflow.md)) |
| Security exposure | Anti-injection rules in-prompt + a website security layer ([09](09-website-security.md)) |
| Blind / invisible failures | Trace + hook-based summary and failure runs ([03](03-solution-architecture.md)) |

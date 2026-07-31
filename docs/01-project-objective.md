# 1. Project Objective and Overview

## In plain terms

Sportnavi is a German corporate-fitness network. Its support team answers the
same questions over and over — memberships, tariffs, cancellation, pauses,
cashback, the app, check-ins, corporate fitness. **Navio** is an AI assistant
that answers those questions automatically, 24/7, in Sportnavi's warm and
informal voice — and, critically, **only from verified information**, so it
doesn't mislead customers.

The vision: *an AI assistant that provides accurate public information, improves
the customer experience, reduces support effort, and continuously gets better
through feedback and evaluation.*

## The objective

Build a support chatbot that:
1. **Answers accurately** within a known, curated knowledge base.
2. **Refuses gracefully** when a question is outside that knowledge ("I don't
   know — here's how to reach the team") instead of inventing an answer.
3. **Stays on brand** — informal German "du," warm, lightly playful, never
   robotic, and mirrors the user's language.
4. **Is measurable and improvable** — every change can be evaluated with data.

## The business problem

Human support does not scale, and inconsistency is expensive. Every repeated
question a bot can answer correctly is support time saved and a faster answer for
the customer. But a support bot that gets facts *wrong* — a made-up price, an
incorrect cancellation rule — is worse than no bot, because it erodes trust and
creates follow-up tickets. So the real problem isn't "add a chatbot"; it's
"add a chatbot that is **reliably correct and honest about its limits**."

## Why an AI chatbot (and not, say, a static FAQ page)

Sportnavi already has FAQ pages. The gap they don't fill:
- Users ask in **their own words**, with typos, indirection, and follow-ups — a
  static page requires them to find the right entry themselves.
- Users combine topics ("can I pause *and* cancel?") — a page answers each in
  isolation; an assistant can synthesize.
- Users ask in **multiple languages** — the assistant mirrors them.
- Support wants **one consistent source of truth** that improves over time.

An LLM assistant grounded in the curated FAQ gives natural, synthesized,
multilingual answers while staying bounded to approved facts.

## Target users

| Audience | What they ask Navio |
|---|---|
| **Members / employees** | How Sportnavi works, the app, check-in, billing, pauses, cancellation |
| **Companies** | How Firmenfitness works, benefits, cost split, setup |
| **Partner studios** | How to become a partner, the portal, check-ins, payouts |

Navio adapts its *depth* per audience (more precision for B2B) while keeping the
same warm tone.

## Value provided

- **Better customer experience** — instant, accurate, on-brand answers.
- **Lower support load** — fewer repetitive tickets.
- **Higher first-response accuracy** — grounded answers, not guesses.
- **A compounding asset** — a measurable system that gets better every iteration,
  rather than a one-off deployment.

## What existed before this work

The agent existed but was a black box: no visibility into cost, latency, or
quality, no way to measure whether a change helped, and a knowledge base with
known factual errors and no systematic way to fix them. Those gaps are the
subject of the next document.

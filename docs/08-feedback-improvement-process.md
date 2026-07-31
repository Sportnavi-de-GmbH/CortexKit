# 8. Feedback Integration Process

## In plain terms

The chatbot gets smarter by learning from where it falls short. Feedback — from
users, support staff, and internal reviews — is turned into concrete knowledge-
base improvements through a repeatable loop. This document defines that loop and
the (planned) sources that feed it.

## 8.1 The feedback → knowledge loop

```
User Feedback
      ↓
Problem Identification            (what went wrong, and why)
      ↓
Missing Knowledge / Edge-Case Discovery
      ↓
Internal Review                   (confirm the correct answer/policy)
      ↓
Knowledge Base Update             (+ a regression test)
      ↓
Better Chatbot Responses
```

The important property: feedback doesn't just get "logged" — it produces a
**verified KB entry and a test**, so the same failure can't silently return.

## 8.2 Feedback sources

**Already used**
- **Internal tester feedback** (`feedback/*.docx`) — the original review that
  surfaced the six wrong facts and drove the v5/v6 corrections.
- **Evaluation failures** — LangSmith experiments that pinpoint the exact samples
  where the bot hallucinates or errs.

**Planned (production)**
- **User conversations** — real questions reveal phrasings and gaps we didn't
  anticipate.
- **Customer complaints** — the strongest signal of a wrong or unhelpful answer.
- **Support observations** — patterns the human team notices ("everyone asks X").
- **Failed / deferred chatbot responses** — every "I don't know" is a candidate KB
  entry.

## 8.3 What feedback should help us find

- **Missing information** — topics with no KB answer.
- **Incorrect answers** — facts the KB gets wrong (highest urgency).
- **Hallucination risks** — questions that tempt the model to invent specifics.
- **New business scenarios** — situations the KB never anticipated.
- **Areas needing clarification** — where the KB is ambiguous or contradicts
  itself.

## 8.4 How each feedback item is triaged

1. **Reproduce & classify.** Is it a *wrong fact* (KB says something false), a
   *gap* (KB is silent), an *ambiguity* (KB contradicts itself), or a *behavior*
   issue (tone, language, refusal)? The LangSmith trace + judge reasoning usually
   makes this obvious.
2. **Separate real failures from expected ones.** Security samples that get
   blocked are *safety passes*, not failures — don't "fix" them.
3. **Route it.** Wrong fact / gap → the KB-gap backlog and the team Excel
   ([07](07-internal-team-workflow.md)). Behavior issue → a prompt change
   candidate ([04](04-system-prompt-engineering.md)).
4. **Confirm the truth.** Especially for policy/pricing, verify with the business
   owner before publishing (a wrong fix is worse than the gap).
5. **Update + test + evaluate.** Fold the verified answer into the KB, add a
   benchmark sample, run `eval:dev` → `eval:run`, promote only on pass.

## 8.5 Closing the loop with production monitoring (planned)

In production we'll add **online evaluation** on a sample of live traffic (not
just offline experiments), plus thumbs-up/down capture in the widget. Low-rated
turns flow straight into step 1 of the loop above. This is how the bot keeps
improving from real usage, not just from curated tests — detailed in
[11-future-roadmap.md](11-future-roadmap.md).

## 8.6 Why this process matters

Without a defined loop, feedback either gets lost or gets applied inconsistently
(and sometimes introduces new errors). With it, every complaint or failure becomes
a permanent, tested improvement — the mechanism that turns the chatbot from a
static deployment into a system that measurably gets better over time.

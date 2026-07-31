# 7. Internal Team Knowledge Improvement Process

## In plain terms

The people who know Sportnavi best are the internal team, not the developers. So
we built a **dead-simple workflow** for them to grow the chatbot's knowledge: an
Excel file with two columns — a suggested question, and a blank space for the
correct answer. They read the question, write the answer. No technical knowledge
required.

## 7.1 Why a two-column Excel (and nothing more)

We deliberately rejected a complex "knowledge management" file with many metadata
fields. The internal team's job should be exactly two steps:

1. **Read** the suggested question.
2. **Add** (or improve/validate) the correct answer.

| User Question | Correct Answer |
|---|---|
| A realistic question a customer would ask | *(the team fills this in)* |

Anything more — categories, priorities, statuses — is developer/planning overhead
that slows the team down. The rich, prioritized backlog exists separately (for
developers) so the team's file stays clean.

## 7.2 The files (in `knowledge_base_improvement/`)

- **`kb_questions_to_answer.xlsx`** — 59 realistic questions across all topics,
  including the known wrong-answer traps, grouped by theme. Answers blank.
- **`kb_edge_cases_blindspots.xlsx`** — 51 **new** edge cases that are *not*
  covered anywhere today (legal right-of-withdrawal, life events like moving
  abroad, Firmenfitness special cases, check-in failures, tax/insurance,
  ambiguous one-liners, follow-ups, competitor comparisons). Answers blank.
- **`kb_gap_backlog.csv`** — the richer, prioritized planning backlog (sources,
  status, priority) for developers/PMs — not for the fill-in team.

## 7.3 The focus: extend, don't duplicate

The questions are chosen to **expand** coverage, not repeat existing FAQs:
- **Missing questions** the KB has no answer for.
- **Tricky / ambiguous** phrasings ("Ich will kündigen." — cancel *what*?).
- **Edge cases** and real customer scenarios (bereavement, unpaid leave, app
  outage during a visit).
- **Questions the current system prompt does not cover** — the blind spots.

Every question was cross-checked against the current (v6) knowledge base so the
team isn't re-answering things the bot already handles.

## 7.4 The one rule the team must follow

**Where there is no official rule yet, write "confirm internally" — do not guess.**
The whole value of the KB is that it's *verified*. A wrong "correction" is worse
than an honest gap, because the bot will then state the wrong thing confidently.
Tester-sourced facts should be confirmed with the business owner before
publishing; prices and legal figures must be kept current by a named owner.

## 7.5 From filled Excel to live chatbot (the handoff)

Once the team fills in answers, a developer:
1. Takes the verified answers and **folds them into the knowledge base** (the KB
   section of the system prompt), or into the "business-critical corrections"
   block if the fact contradicts existing KB wording.
2. **Adds a matching test** to the benchmark dataset (question + reference answer)
   so the new fact is protected against future regressions
   ([05](05-experiment-analysis.md)).
3. **Evaluates** the updated prompt as a new candidate on `eval:dev`, confirms no
   regressions, then on the full `eval:run`.
4. Promotes the change only after it passes — never by editing the live prompt
   directly (see [10-operations.md](10-operations.md)).

## 7.6 Ownership

- **Internal team / interns:** fill and validate answers; flag anything they're
  unsure about as "confirm internally."
- **Business owner:** confirms policy-level facts (prices, notice periods, legal
  rules).
- **Developer:** folds verified answers into the KB, adds tests, runs
  experiments, and promotes changes.

This division is what makes the system *continuously* improvable without turning
every knowledge update into an engineering project.

# Knowledge Base Improvement Backlog

A living backlog of knowledge-base gaps for the Sportnavi (Navio) chatbot,
built from evidence — not guesses. Use `kb_gap_backlog.csv` as the working
list; open it in Excel/Google Sheets, filter, assign, and extend it.

## What's in the file

`kb_gap_backlog.csv` — 42 entries, one per potential KB improvement. Columns:

| Column | Meaning |
|---|---|
| Category / Topic | Grouping for filtering/sorting |
| User Question | How a normal user asks it |
| Tricky User Question | Indirect/ambiguous/edge phrasing a real user might use |
| Expected Answer | The verified correct answer — **or** `TBD — …` where the fact is genuinely undocumented and the team must supply it (never invented) |
| Source | Where the fact/gap comes from (tester feedback, an eval sample, or a real sportnavi.de URL) |
| Priority | High / Medium / Low |
| Confidence | High = verified fact · Medium = partly known · Low = needs business confirmation |
| Reason for Adding | Why it matters (correctness, hallucination, support load…) |
| Related Feedback / Experiment | Traceability to a tester issue or LangSmith eval sample |
| Status | **Needs Update** (KB has it wrong) · **Missing** (not in KB) · **Already Covered** (verify only) |
| Notes for KB Team | Concrete action |

## How to read the Status column

- **Needs Update (14)** — the KB currently states something *wrong or imprecise*.
  These are the most urgent: the bot actively misleads users today. Every one
  traces to a tester correction or a website conflict.
- **Missing (14)** — the KB is *silent*; the bot either defers or hallucinates.
  Many have `TBD` expected answers because only Sportnavi can supply the fact.
- **Already Covered (14)** — included for completeness / a quick correctness
  double-check; low effort.

## Start here (highest value)

The 8 **High-priority** rows are where to begin — most are `Needs Update`
facts the chatbot gets wrong *right now*:

1. Pause + usage (KB says "not usable" — actually using it *cancels* the pause)
2. Cashback multi-tickets (only single tickets are reimbursable)
3. Firmenfitness notice period (2 weeks membership vs 3 months framework contract)
4. Cancellation channel (dedicated Kündigungsformular, not the contact form)
5. Referral premium timing (after 3 months of the referred member)
6. Exact tariff prices (49,90 / 74,90 / 139,90 € — currently "see website")
7. Support hours (site says 8:30, KB says 9:00)
8. Pause-splitting rule (undocumented → confirm with the business owner)

## Two important cautions for the team

1. **`TBD` rows need a human, not the bot.** Where Expected Answer starts with
   `TBD`, only Sportnavi can supply the real policy. Do not let the chatbot
   fill these in — that's precisely how hallucinations happen.
2. **Verify tester-sourced facts.** Several corrections came from *testers*,
   not an official Sportnavi source. Confirm them with the business owner
   before publishing — a wrong "correction" is worse than the original gap.
   Prices and legal figures (Sachbezug 50 €, tariff prices) also drift over
   time; assign an owner to keep them current.

## Provenance

Evidence sources behind these entries:
- Tester feedback: `feedback/Feedback Chatbot.docx`, `feedback/Feedback2.docx`
  (analysed in `agent/feedback/FEEDBACK-ANALYSIS.md`).
- LangSmith eval failures (dev-10 and full-60 experiments, 2026-07-28/29).
- The v6 optimized system prompt's verified-corrections block.
- Official site: sportnavi.de member pages, FAQ, and tariff page (fetched 2026-07-29).

Regenerate/extend by editing the CSV directly, or ask to have new rows added
as new evidence (support tickets, new eval runs) comes in.

# 6. Knowledge Base Strategy

## In plain terms

The chatbot only knows what's in its knowledge base. About **90% of that
knowledge was collected from public Sportnavi sources** — the official website,
its FAQ pages, member and company-fitness information, and app documentation. The
remaining ~10% comes from internal knowledge and corrections. The knowledge base
is not frozen: it improves continuously from public updates, the internal team,
user feedback, and failed conversations.

## 6.1 Where the knowledge came from

**~90% public sources.** The core FAQ content was collected from publicly
available Sportnavi material, primarily:
- The official website (member pages: `sportnavi.de/fuer-mitglieder/`).
- The public FAQ sections (e.g. `sportnavi.de/faq/…` — general, members, company
  fitness).
- The tariff/pricing page (`sportnavi.de/fuer-mitglieder/tarife/`).
- Company-fitness (Firmenfitness) information and app usage documentation.

**~10% internal.** Facts the public pages don't state clearly, plus the
**verified corrections** the internal testers provided (e.g. the true pause-usage
behavior, single-ticket-only cashback, the correct notice periods).

## 6.2 How public information became chatbot knowledge

1. **Collection** — relevant public FAQ content was gathered by topic
   (memberships, tariffs, cancellation, pause, cashback, app, check-in,
   Firmenfitness, partners, contact).
2. **Structuring** — organized into topic documents and embedded into the system
   prompt as the "knowledge base" section (see
   [04](04-system-prompt-engineering.md)). Because it lives in the prompt, "adding
   knowledge" literally means adding well-structured text.
3. **Validation** — cross-checked against the live site and against tester
   feedback. This is how we caught conflicts, e.g. the website lists support hours
   as **Mon–Fri 8:30–17:00** while the KB said **9:00–17:00**, and it carries the
   real tariff prices (**3★ €49,90 / 4★ €74,90 / 5★ €139,90**) that the KB left as
   "see website" — a gap that caused hallucinations.

## 6.3 Why "public-first" was the right sourcing strategy

- **Accuracy & authority** — public official pages are the source of truth
  customers themselves see; grounding on them keeps the bot consistent with
  Sportnavi's own messaging.
- **Coverage fast** — the public FAQ already answers the majority of common
  questions, so the bot was useful quickly.
- **Auditable** — every embedded fact can be traced back to a public page (or an
  explicit internal correction), which is exactly what a support bot needs.

The trade-off: public pages are **incomplete** (they don't cover many real edge
cases) and occasionally **out of date or inconsistent** with internal reality —
which is why the improvement loop below exists.

## 6.4 The continuous-improvement strategy

The knowledge base improves through five channels:

1. **Public information updates** — when the website changes (prices, hours, new
   offerings), the KB is updated to match. Prices and legal figures **drift**, so
   they need an owner.
2. **Internal team knowledge** — facts only Sportnavi knows (policies, exceptions,
   processes) added via the team workflow ([07](07-internal-team-workflow.md)).
3. **User feedback** — real questions and complaints surface gaps
   ([08](08-feedback-improvement-process.md)).
4. **Failed chatbot conversations** — where the bot deferred or answered wrong
   becomes a KB entry.
5. **Experiment analysis** — LangSmith evaluations pinpoint the exact samples that
   fail, which become KB fixes ([05](05-experiment-analysis.md)).

## 6.5 How gaps are identified (evidence, not opinion)

We produced a **knowledge-gap backlog** grounded in three evidence streams:
- **Tester feedback** (`feedback/*.docx`, analyzed in
  `agent/feedback/FEEDBACK-ANALYSIS.md`) — nine issues, six of them wrong KB
  facts.
- **Eval failures** — the specific benchmark samples where the bot hallucinated or
  erred.
- **The live website diffed against the KB** — surfacing missing facts (real
  prices, the 14-day right of withdrawal, regional coverage) and conflicts
  (support hours, check-in frequency).

The artifacts live in `knowledge_base_improvement/` and feed directly into the
team workflow in the next document.

## 6.6 The golden rule for KB content

**Never invent a fact to fill a gap.** Where the correct answer isn't known, the
KB entry stays marked "confirm internally" and the bot is instructed to defer to
support. Inventing answers to look complete is precisely how hallucinations start
— so the KB grows only with *verified* facts.

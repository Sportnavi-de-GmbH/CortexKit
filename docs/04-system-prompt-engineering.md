# 4. System Prompt Engineering and AI Behavior Design

## In plain terms

The chatbot's "brain" is a single, carefully written document — the **system
prompt** — that contains its personality, its rules, and the entire Sportnavi
knowledge base. We control what the bot does by editing that document, not by
writing code. We chose this "prompt + curated knowledge" approach on purpose; this
file explains why, what it costs us, and when we'll outgrow it and move toward
RAG.

## 4.1 Why prompt engineering instead of RAG (at this stage)

RAG (Retrieval-Augmented Generation) fetches relevant documents from a database at
answer time and feeds them to the model. It's the right tool when your knowledge
is **too large to fit in the prompt** or **highly dynamic**. Ours is neither yet
— the Sportnavi FAQ is ~16k tokens. So we embedded the whole KB directly in the
prompt. The benefits at this stage:

- **Faster iteration.** Changing behavior or a fact = editing one text file, then
  re-running an evaluation. No embedding pipeline, no re-indexing.
- **More control over behavior.** The persona, rules, and every fact are in one
  place, in a deliberate order. Nothing is hidden behind a retriever's ranking.
- **Easier testing.** The prompt is fully deterministic input; we can diff
  versions and A/B them cleanly.
- **Lower complexity & cost.** No vector store, no chunking strategy, no retriever
  to tune or host. The agent has **no tools at all**, which also removes a whole
  class of failures and an attack surface. And because Azure caches the stable
  ~16k prefix, ~99% of the prompt is billed at the cheap cached rate.
- **Perfect recall.** With the whole KB in context, the model never "misses" a
  relevant fact because retrieval ranked it low — there is no retrieval step to
  get wrong.

## 4.2 The limitations we accept

- **Throughput ceiling.** The big prompt is re-sent every turn, so
  tokens-per-minute (TPM) is the binding constraint (~2 turns/min at a 50k TPM
  budget). Caching cuts cost, not TPM.
- **Manual updates.** Facts are prose; updating means editing and re-verifying.
- **Context-size limit.** As the KB grows toward tens of thousands of tokens,
  cost/latency/TPM pressure grows with it.
- **Consistency is fragile.** If the same fact appears twice with different
  wording, the model can follow the wrong one — this caused a real bug (below).

## 4.3 How AI behavior is structured (v6)

The current best prompt (v6) is organized into nine ordered sections plus a
security block. **Order is a design tool:**

1. Role & purpose 2. Core behavior rules 3. Answer quality 4. Fact accuracy &
verification 5. **Business-critical corrections** 6. KB usage rules → *[the
knowledge base]* → 7. Language & communication 8. Ambiguity handling 9. Response
efficiency → Security / anti-injection.

- The **business-critical corrections** sit *just before* the KB and explicitly
  state they **override the KB on conflict** — this is how we force the model to
  use a corrected fact even when the KB text disagrees.
- **Language, ambiguity, and security** rules sit *after* the KB, for **recency**
  — the model reads them right before it answers, which matters most for refusals
  and edge cases.

## 4.4 How business rules are controlled

Business behavior is encoded as explicit rules, e.g.:
- Never quote custom pricing to a company — defer to a sales conversation.
- Never state a fixed per-check-in rate to a partner — turn the question around.
- Never book appointments or capture personal data — refer to support.
- Never invent an undocumented number, date, price, or policy.
Because these are in the prompt, product/policy changes are a text edit, not a
deployment.

## 4.5 How the prompt evolved (v1 → v6) and what each version taught us

We didn't guess our way to v6 — every version was measured (see
[05](05-experiment-analysis.md)).

| Version | Change | What the evidence showed |
|---|---|---|
| **v1** | Remove a duplicate KB document | −17% tokens, quality unchanged → **keep** |
| **v2** | Patch one pause "cheat-sheet" line | **No effect** — the bug persisted |
| **v3** | Add a language reminder | No reliable improvement (mirroring is partly stochastic) |
| **v4** | Set a brevity default | No score change (the length ceiling never bound) |
| **v5** | Combine v1–v4 + a "verified corrections" block | Best of the first five; fixed a price-anchor miss; **still failed the pause bug** |
| **v6** | Re-architect + fix the pause bug *at the root* + add ambiguity handling | **Best quality, smallest prompt, and finally fixes the pause bug** |

**The most important lesson lives in v2/v5 → v6.** We "fixed" the pause-splitting
contradiction in v2 and v5 by editing a summary line — and the evaluation proved
it *still failed*, because the misleading word ("flexibel") survived in the
*main* KB text, not just the summary. Only v6 fixed it properly: we removed the
word from the KB itself **and** added an explicit override. **You cannot instruct
your way out of a knowledge base that states the wrong fact in its own body —
you must fix the text and add the override.**

## 4.6 What makes a good system prompt (our principles)

- **Every instruction must earn its tokens.** We deleted v3's reminder block and
  v4's verbose text because they showed no measurable benefit — which is why v6 is
  *smaller* than v5. "Sounds good" is not a reason to keep an instruction.
- **Put authoritative facts where the model will attend to them** (corrections
  before the KB; language/security after it).
- **Fix contradictions at the source.**
- **Reduce hallucinations with explicit boundaries**, not hope: a "never invent"
  rule plus hard-coded corrections for the facts most often gotten wrong.

## 4.7 Future evolution: toward RAG

As the knowledge base grows (more partners, live prices, richer policies), the
prompt-embedded approach hits its ceiling. The planned evolution is a **hybrid**:

```
System Prompt            (persona + rules + core stable facts — stays in prompt)
        +
Knowledge Base           (the stable curated FAQ)
        +
RAG Retrieval Layer      (FUTURE — fetch large/dynamic content: partner catalog,
                          current prices, region-specific data)
```

**When RAG becomes necessary:** when the KB outgrows what's economical to send
every turn (~30–40k+ tokens), or the content becomes dynamic (live prices,
per-partner availability), or you need citations/personalization. The current
architecture prepares for this by keeping the *stable* persona/rules/core-facts
cleanly separable from the *bulky/dynamic* knowledge, so retrieval can later feed
just the latter. Full roadmap in [11-future-roadmap.md](11-future-roadmap.md).

# AGENT_ONBOARDING.md — Navio Partner Recommendation Agent

> **Purpose.** Hand this single file to any AI agent that has never seen this
> repo and it should be able to work correctly without reading anything else
> first. It is a condensed, standalone brief — not a replacement for
> [`CLAUDE.md`](CLAUDE.md) (the rule sheet) or
> [`PROJECT_CONTEXT.md`](PROJECT_CONTEXT.md) (the full manual). Read those two
> for anything this file doesn't answer.
>
> **Verified against source:** `agent/tools/`, `agent/agent.ts`,
> `agent/config/partner-injection.config.ts` — 2026-08-02.
>
> **Golden rule of this repo:** several docs describe an architecture that no
> longer exists (`partner-recommendation-agent/README.md`, the gitignored
> `.eve/agent-summary.json`, `tests/agent-test/`). If prose and source
> disagree, **source wins**. Only `agent/` and `lib/` are authoritative.

---

## 1. What this agent does, in one paragraph

A user asks Navio, Sportnavi's chatbot, for somewhere to train — usually in
informal German ("Kletterkurse für Anfänger in Bochum"). Navio calls one tool
that resolves the city, pulls every active partner in that city, tops up any
shortfall from nearby cities by embedding similarity (disclosing every
borrow), and returns a ranked shortlist with full profiles and contact
details. Navio then writes the prose answer. **It never invents a partner,
price, hour, or service** — that's the product's core promise, not a style
choice.

---

## 2. Request lifecycle (what actually happens, in order)

```
User message
  │
  ▼
[Model step 1] LLM reads the message, decides to search, calls:
  find_partners({ cityMention, intentText, tags, finalRecommendations? })
  │
  ├─ cache lookup (key includes cityMention + tags + finalRecommendations + intentText)
  │   → HIT: return cached result immediately
  │
  ├─ resolveCityFuzzy(cityMention)          Supabase RPC, trigram match, ≤1 row
  │   → no match / low confidence → return { needsClarification, question }
  │
  ├─ resolvePartners({ city, intent })       lib/partners/resolve-partners.ts
  │   1. fetch ALL active partners in the home city (whole, unconditionally)
  │   2. if home count < minPartners: gap-fill from nearby cities
  │      (Promise.allSettled, nearest-first, similarity-ranked, concurrent)
  │   3. cap at maxPartners
  │
  ├─ buildRecommendations({ set, finalRecommendations })
  │      rank (home first, then nearby by similarity) → take top N →
  │      ONE batched get_partner_profiles RPC to hydrate full profiles →
  │      compose the honest disclosure string
  │
  ├─ emitResolutionEvent(...)   fire-and-forget observability, never throws
  │
  └─ toModelOutput(): returns rendered Tier-2 profile blocks + disclosure text
       (the model never sees the raw structured JSON)
  │
  ▼
[Model step 2] LLM writes the German prose answer using only what the tool returned
```

**Health signal:** a search should be exactly **2 model steps**. If you ever
see 4, the old three-tool chain (`extract_city → resolve_partners →
build_recommendations`) has come back — that's a regression, not a feature.
Non-search turns (greetings, asking which city) are **1** step.

Follow-up questions about a partner already shown do **not** re-search — they
call `get_partner_details({ partnerId })` for that one partner's full profile.

---

## 3. The tools — there are exactly two live ones

### `find_partners` — the one-call search
File: `agent/tools/find_partners.ts`

| | |
|---|---|
| **Input** | `cityMention: string \| null` (verbatim as user wrote it, may be misspelled), `intentText: string` (what they want, free text), `tags: string[]` (normalized activity tags, e.g. `["yoga"]`), `finalRecommendations?: number` (how many to return, capped at `maxPartners`) |
| **Output to model** | Rendered Tier-2 text: full profile blocks for the shortlist + one disclosure paragraph. Never raw JSON. |
| **Output to channel/UI/tests** | The full structured object (`execute()` return), including a `resolution` summary (`homeCount`, `filledCount`, `citiesUsed`, `minMet`, `cappedAtMax`, `citiesExhausted`) for the dev console — this costs **zero** prompt tokens because `toModelOutput` is what's actually sent to the LLM. |
| **On ambiguous/unresolved city** | Returns `{ needsClarification: true, question }`. The model must ask that exact question, not guess. |
| **Caching** | In-process TTL cache (1 h, 500 entries), keyed on `(cityMention, sorted tags, finalRecommendations, intentText)`. Only successful searches are cached — clarification results are not, so a data fix or a rephrase is never stuck behind a stale cache entry. |
| **Why one tool, not a chain** | Measured 2026-07-31: the old 3-tool chain cost 4 model steps, with steps 1–3 producing only 17–82 output tokens each while re-sending the whole ~11k-token prefix every time. `extract_city` also hid a second LLM call just to re-parse a city the main model had already read (6.7–14.5 s of latency for ~180 tokens of work). Consolidating cut input tokens ~56% and latency roughly in half. **Do not re-split this without measuring first.** |

### `get_partner_details` — single-partner follow-up lookup
File: `agent/tools/get_partner_details.ts`

| | |
|---|---|
| **Input** | `partnerId: number` |
| **Purpose** | Fetch one partner's complete profile (address, contact, website, full description, courses) when a follow-up question needs detail no longer in context. |
| **Rule** | Follow-ups only. Never called during a search, never used to re-derive a partner already discussed in the current shortlist. |
| **Implementation** | A thin wrapper — all logic lives in `lib/partners/get-partner-details.ts`, because eve tools cannot call other tools; shared logic must live in plain functions. |

### Nine other tools exist and are all disabled (`disableTool()`)

`web_search`, `web_fetch`, `bash`, `write_file`, `read_file`, `glob`, `grep`,
`todo`, `agent` (eve's built-in subagent-spawning tool).

**Why disabled:**
- `web_search` / `web_fetch` — the Sportnavi directory is the *only* source of
  truth. A partner's live website can be outdated or belong to a different
  business; the model must never cite it as if it were the directory.
- `bash`, `write_file`, `read_file`, `glob`, `grep`, `todo`, `agent` — eve's
  generic coding-agent tools. Measured cost: **1,469 tokens on every single
  model call** just for their schemas. `bash` and `write_file` are also RCE
  surfaces reachable through prompt injection in user chat text.

**Every tool — enabled or not — that appears in the schema costs tokens on
every model call of every step.** The historical win here was going from 17
tools down to 2; don't add a third without an eval proving it pays for itself.

---

## 4. The deterministic pipeline (`lib/partners/`)

The model is deliberately kept away from anything that can be computed
exactly — counting, deduping, ranking, thresholding. That all lives here,
with injectable dependencies and mocked unit tests.

| Module | Responsibility |
|---|---|
| `resolve-partners.ts` | **Orchestrator.** Home city whole → concurrent gap-fill from nearby cities → cap at `maxPartners`. Per-stage timings recorded. |
| `extract-city.ts` | `resolveCityFuzzy` (Supabase RPC, **the only part on the live path**) + a legacy `generateObject` LLM extractor used only by tests/eval. |
| `get-partners-by-city.ts` | All active partners for one city. Best-effort join to `partner_intelligence.quality_score` (no FK exists, so it's a manual second query). Never selects `email`/`phone`. |
| `find-nearby-cities.ts` | No `cities` table exists — derives city centroids from partner lat/lng via the `city_centroids()` RPC, ranks candidates by Haversine distance, caches 24 h. |
| `similarity-search-partners.ts` | Per nearby city: embed the intent once, call `match_partners` RPC, apply client-side tag filtering. |
| `build-recommendations.ts` | Ranks (home first, then nearby by similarity) → takes top N → hydrates via one batched `get_partner_profiles` RPC → composes the disclosure text. Drops any partner whose profile hydrated empty. |
| `render-context.ts` | Renders Tier-2 (full profile blocks). Also launders internal warnings/errors into fixed, safe phrases before they can reach the model. |
| `search-cache.ts` | The in-process TTL cache described above. |
| `types.ts` | `PartnerLite` — the only partner shape ever allowed into model context. **Never add `email`/`phone` here** — see §6. |

**Failure asymmetry (deliberate):** a failed home-city fetch is a hard error.
A failed nearby-city fetch just gets skipped with a logged warning — one slow
or broken neighbor should never block the response for the city the user
actually asked about.

---

## 5. The system prompt (`agent/instructions.md`, ~18 KB)

Read the whole file before editing it — it's short enough, and every rule in
it exists because of a specific failure mode. In brief:

1. **Grounding mandate**, stated first, before persona or anything else: "You
   do not know any partners. Not one." Every named business must come from a
   `find_partners` result in *this* conversation. This exists because an
   earlier instruction rewrite caused the model to stop calling tools
   entirely and fabricate confident, detailed, entirely invented partner
   listings — see §8 below. **Never weaken this or move it lower in the
   file.**
2. **Persona** — Navio: friendly, motivating, informal German, emoji for
   scannability — explicitly subordinate to the honesty rules above it.
3. **Coverage** — the database decides what's covered, not the model. A
   generated list of the 40 largest cities exists only to offer concrete
   alternatives; it must never be used to conclude a city has no coverage.
4. **Call `find_partners` once, then answer.** Don't chain tools.
5. **Guided-choice questioning** — never a bare "which city?"; offer real
   covered cities or category buckets.
6. **Intent decomposition** — the "driver" behind the ask (e.g. "sanft wieder
   einsteigen" / gently getting back into it) is the easiest signal to drop
   and the most important one; it must be carried into `intentText` verbatim.
7. **Ten non-negotiable rules**, most importantly:
   - Home-city priority is absolute (§4 above).
   - Disclose borrowing, thin coverage, and fit mismatches.
   - **Rule #6 — include partner contact details (address/phone/email)
     verbatim, unprompted, no confirmation step.** This was inverted on
     2026-08-01: contact info is *public directory information the partner
     published to be contacted through*, not PII to withhold. See §6.
   - Copy contact data exactly from the profile — never guess, complete, or
     "correct" a missing field. A wrong phone number is worse than a missing
     one because the user can't detect the error until it's too late.
   - Never surface internal placeholder tokens (e.g. the literal string
     `not_available`) or field names like `body_markdown` to the user.
   - **Rule #10** (studio attributes / hours / pricing) is intentionally long
     and repetitive with a worked example, because eval runs reproduced a
     failure where the model correctly refused to state opening hours *and,
     in the same message,* fabricated a detailed pricing structure labeled
     "laut Profil". The model resolves "don't guess" vs. "be helpful"
     inconsistently, field by field, within a single response. **Do not
     compress rule #10 without re-running the eval.**

**Known, accepted drift:** a couple of lines in the prompt still reference
`extract_city`/`resolve_partners` by name even though only `find_partners`
exists now. Harmless in practice but worth fixing by renaming, not deleting.

---

## 6. Contact data — one rule, one reason

`email` and `phone` are **never** selected into `PartnerLite` (the shape that
reaches the model during ranking). They reach the model through exactly one
path: the pre-rendered `llm_profile` block of the final shortlist, gated by
`includeContactInShortlist` (default `true`, and it must stay `true` — see
the config comment in §7). This is not a privacy control — contact details
are meant to appear in answers, because getting the user to the studio door
is the entire point of the product. It's **context hygiene**: one canonical
source prevents the model from seeing the same fact in two shapes and
reconciling them inconsistently. Do not add `email`/`phone` anywhere else.

Coverage gaps are real and expected (verified live 2026-08-01): `phone`
missing on 15% of active partners, `email` on 25%, `street` on 5%,
`website_url` on 0%. Missing fields render as the literal placeholder
`not_available` in the profile — the prompt forbids echoing that token to the
user.

---

## 7. Configuration — the four dials (`agent/config/partner-injection.config.ts`)

Single source of truth; nothing else hard-codes these numbers.

| Dial | Meaning | Active value (`DEFAULT_CONFIG`) | `PRESETS.PRODUCTION_BASELINE` |
|---|---|---|---|
| `minPartners` | Gap-fill **target**, not a warning floor — borrowing stops once home count reaches this | 100 | 12 |
| `maxPartners` | Hard ceiling injected into context | 100 | 100 |
| `maxCities` | Max cities (home + nearby) drawn from | 10 | 4 |
| `finalRecommendations` | How many the user ultimately sees | 100 | 100 |
| `similarityThreshold` | Min cosine similarity to accept a gap-fill partner | 0.15 | 0.35 |
| `maxDistanceKm` | Max distance to borrow from | 150 | 60 |
| `dedupHeadroom` | Extra candidates fetched to survive filtering | 20 | 5 |

**`DEFAULT_CONFIG` right now is a deliberate wide-context test profile, not
production tuning.** At `minPartners: 100`, nearly every city except
Bielefeld (the one city with 100+ partners) triggers gap-fill, which is what
makes cross-city injection observable at all — at the old value of 12, any
city with ≥12 partners already met the floor and the nearby-city path never
ran. Reverting is one line: `export const DEFAULT_CONFIG =
PRESETS.PRODUCTION_BASELINE`. **Do not silently revert or "fix" this — it's
an intentional experiment; ask first.**

Other presets: `LOCAL_FIRST` (tighter, closer), `WIDE_NET`, `STRICT_CITY`
(`maxCities: 1` disables gap-fill entirely — useful for isolating home-city
behavior in tests).

`includeContactInShortlist` must stay `true` — see §6.

---

## 8. History worth not repeating (read before "optimizing" anything)

**The cost optimization that nearly shipped a fabricating agent.** An early
rewrite of `find_partners`'s tool description replaced three bare imperatives
with a softer heading plus a paragraph starting "Do not chain tools to do
this." The model generalized that into "do not call tools." Result: it
answered fluently, in German, with five confidently-described studios and
invented details attributed to "laut Profil" — having **never queried the
database**. It looked like a huge win on every efficiency metric: $0.0106 vs.
baseline, −58% cost, faster responses. It was cheap and fast *because* it was
fabricating.

Three lessons that generalize to any change in this repo:

- **A cost optimization that reduces work is indistinguishable from one that
  skips work if you only look at cost.** Both graphs go the same direction.
- **The cheapest possible agent hallucinates.** Every efficiency metric needs
  a paired work-actually-performed metric (e.g. "was `find_partners` called
  at all", "profiles hydrated ÷ partners shortlisted").
- **Negative instructions leak.** State what the model *must* do, not just
  what it shouldn't. "Don't chain tools" was meant narrowly and was read
  broadly enough to skip tools entirely.

---

## 9. Things you must not change without stopping to ask first

1. The grounding mandate's position at the top of `instructions.md`.
2. Rule #10's redundancy/worked example in `instructions.md`.
3. The home-city-whole rule — a Bochum request gets all of Bochum, no
   silent trimming except the configured overflow strategy.
4. Contact data staying out of `PartnerLite` and routed only through
   `llm_profile` (§6).
5. `web_search` / `web_fetch` staying disabled.
6. Tool count — two is the current budget.
7. Determinism — no `Math.random`; every sort has an id-ascending tiebreak.
8. `DEFAULT_CONFIG` being the wide-context test profile (§7) — revert only
   with explicit sign-off.

---

## 10. Where to look next

- **Full detail on everything above, plus DB schema, RPCs, indexes, known
  open bugs, and the roadmap:** [`CLAUDE.md`](CLAUDE.md) (rule sheet) and
  [`PROJECT_CONTEXT.md`](PROJECT_CONTEXT.md) (full manual, file-by-file map).
- **Deepest analysis of the cost/latency refactor:**
  `partner-recommendation-agent/reports/markdown/Cost-And-Latency-Optimization-Report.md`
- **Current eval harness:** `partner-recommendation-agent/evals/` (10 edge
  cases, 14 evaluators). `tests/agent-test/` is retired and cannot execute —
  do not run it.

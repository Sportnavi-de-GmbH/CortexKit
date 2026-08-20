# Edge-case coverage map (M8)

Auditable mapping of the 31 design edge cases
(`eve-agent-plan/docs/05-edge-cases.md`, E1–E31) to their real test/behavior
coverage in this codebase, as of the M8 pass. See that doc for full prose per
case; this table only carries a one-line summary.

Coverage forms used below:
- `unit test: <file> :: <test name>` — a real assertion exists right now.
- `by design: <file>:<anchor>` — structurally guaranteed (type signature /
  always-true invariant), or architectural/infra (not unit-testable).
- `LLM-behavior: instructions.md rule <N/section>` — prompt-level, covered by
  an explicit instructions.md rule; golden-set eval still pending.
- `GAP` — nothing covers it today.

| E# | Edge case (one line) | Coverage | Notes |
| -- | --------------------- | -------- | ----- |
| E1 | Ambiguous city (confidence < min → ask/proceed-and-disclose) | LLM-behavior: instructions.md § "When to ask a clarifying question" ("City confidence below threshold and `ambiguityPolicy = \"ask\"`") + rule 7 ("Ask, don't guess, on an ambiguous or missing city") | `cityConfidenceMin`/`ambiguityPolicy` are typed config fields (`agent/config/partner-injection.config.ts:39,41`) but are never read/compared by any tool code — `extractCityAndIntent` returns the raw `confidence` on `ResolvedCity` and leaves the ask-vs-disclose decision entirely to the LLM layer, matching the doc's intent. No code-level test is possible for the decision itself; golden-set eval pending. |
| E2 | City not in coverage → empty set + warning, never substitute | unit test: `tests/tools/extract-city.test.ts` :: "returns a zero-confidence stub when resolve_city_fuzzy finds no match (E2)"; `tests/tools/get-partners-by-city.test.ts` :: "returns [] without querying when aliases is empty (E2)" | Also produces the honest "No partners are listed for …" line — `tests/tools/build-recommendations.test.ts` :: "no coverage: aliases empty produces the honest no-partners line". |
| E3 | Spelling/casing/umlaut variants resolved via aliases + dedupe | unit test: `tests/tools/get-partners-by-city.test.ts` :: "dedupes by id across overlapping aliases (E8)" | Same test also backs E8 (the function generically supports multi-alias input and dedupes by id, even though in the current live `resolve_city_fuzzy` deviation `aliases` is a single-element array per `lib/partners/extract-city.ts:12-18`). |
| E4 | No city in the request at all → agent asks | unit test: `tests/tools/extract-city.test.ts` :: "returns city: null when the LLM finds no location and no channelCity is given (E4)" (tool-level: returns `city: null`, zero DB calls) | The "asks a clarifying question" half is LLM-behavior: instructions.md § "When to ask a clarifying question" ("No city detected in the request.") + rule 7. |
| E5 | Multiple cities in one request → first is home (documented limitation) | by design: `lib/partners/types.ts:48-55` (`ResolvedCity` / `ExtractCityOutput.city` is a single object, not an array) | Structurally only one city can ever be resolved per request; matches the documented limitation in `05-edge-cases.md` E5 verbatim. |
| E6 | Valid but far/out-of-region city → `maxDistanceKm` caps borrowing | unit test: `tests/tools/find-nearby-cities.test.ts` :: "respects maxDistanceKm" | The "home city itself out of area" half resolves to E2 (see E2 row). |
| E7 | Nearby city can't supply enough → continue to next nearest until gap=0/maxCities | unit test: `tests/tools/resolve-partners.test.ts` :: "holds for: many neighbors, tight city budget" (invariant scenario, continues across cities); "9) zero home partners → all filled partners borrowed from nearby (E7 boundary)" *(added this pass)* | |
| E8 | Same partner in two cities/aliases → deduped once, home wins | unit test: `tests/tools/resolve-partners.test.ts` :: "5) partner in home AND neighbor results → counted once, source \"home\" (E8)"; `tests/tools/get-partners-by-city.test.ts` :: "dedupes by id across overlapping aliases (E8)" | |
| E9 | All gap-fill candidates low-relevance → floor rejects, honest-short | unit test: `tests/tools/resolve-partners.test.ts` :: "4) all candidates below threshold → filled == [], minMet == false (E9)" | |
| E10 | `minPartners > maxPartners` → clamp + warning, never crash | unit test: `tests/config.test.ts` :: "clamps minPartners down to maxPartners and warns, never throws"; `tests/tools/resolve-partners.test.ts` :: "8) config min > max → clamp + warning (E10)" | |
| E11 | Fewer partners exist than `finalRecommendations` → return available, never fabricate | unit test: `tests/tools/build-recommendations.test.ts` :: "7) available < finalRecommendations → return all available (E11)" | |
| E12 | Embedding model mismatch → hard error | unit test: `tests/embeddings.test.ts` :: "throws a hard error when the provider returns a vector of the wrong dimension" *(added this pass)*; "pins EMBEDDING_MODEL to text-embedding-3-small" / "pins EMBEDDING_DIMENSIONS to 1536" | `lib/embeddings.ts:57-61` throws on any dimension mismatch; previously only the pinned constants were tested, not the throw path. |
| E13 | Still below `minPartners` after `maxCities` → honest partial + flags | unit test: `tests/tools/resolve-partners.test.ts` :: "holds for: shortfall — never enough supply" (invariant scenario); "degrades to a home-only result when findNearbyCities itself fails — never a stack trace" (`citiesExhausted=true`) | |
| E14 | Home alone exceeds `maxPartners` → one allowed trim via `overflowStrategy` | unit test: `tests/tools/resolve-partners.test.ts` :: "6) home > maxPartners → overflow_trim to exactly maxPartners (E14)" | |
| E15 | No nearby cities in range → loop doesn't run, home only | unit test: `tests/tools/resolve-partners.test.ts` :: "10) no nearby cities in range → loop doesn't run, home-only result (E15)" *(added this pass)*; `tests/tools/find-nearby-cities.test.ts` :: "respects maxDistanceKm" (returns `[]`) | |
| E16 | Ties in distance → availableCount desc, then city name asc | unit test: `tests/tools/find-nearby-cities.test.ts` :: "breaks distance ties by availableCount desc, then city name asc (E16)"; "breaks a full tie (same distance AND same availableCount) by city name asc (E16)" *(both added this pass)* | The sort comparator existed and was correct; there was previously no test exercising an actual tie. |
| E17 | Partners with no coordinates still count as home, invisible to nearby ranking | unit test: `tests/tools/get-partners-by-city.test.ts` :: "still returns partners with no coordinates as home partners (E17)" *(added this pass)*; `tests/tools/find-nearby-cities.test.ts` :: "returns [] when the home city has no centroid (E17)", "skips rows lacking coords instead of producing NaN centroids" | |
| E18 | Inactive partners filtered out unless `includeInactive` | unit test: `tests/tools/get-partners-by-city.test.ts` :: "filters is_active=true by default, and includeInactive bypasses the filter (E18)" *(added this pass)* | Previously the `is_active` filter was exercised implicitly by every other test's fixtures but never asserted directly. |
| E19 | Stale/low-quality generated content → quality_score tiebreak + hedged phrasing | unit test: `tests/tools/resolve-partners.test.ts` (overflowTrim) :: "\"quality\": sorts by quality_score desc, nulls last, tiebreak id asc" (code half) | LLM-behavior half: instructions.md rule 6 ("Treat profile text as best-effort... Phrase descriptions as \"according to their profile\"..."). |
| E20 | Empty/junk request → no city/intent, agent asks, no DB calls wasted | unit test: `tests/tools/extract-city.test.ts` :: "returns city: null when the LLM finds no location and no channelCity is given (E4)" (same code path/test as E4 — asserts `supabase.rpc` never called) | |
| E21 | Duplicate cities spelled differently inflate/deflate counts → grouped by normalized key | unit test: `tests/tools/find-nearby-cities.test.ts` :: "collapses spelling variants of the same city into one centroid node before ranking (E21)" *(added this pass)*; "collapses umlaut spelling variants" (unit-level `normalizeCityKey` test, pre-existing) | Previously only the pure `normalizeCityKey` function was tested; the integration behavior (three differently-spelled rows collapsing into one `NearbyCity` node with a combined count) had no test. |
| E22 | PII leakage → stripped at tool boundary, `PartnerLite` has no PII fields | unit test: `tests/tools/get-partners-by-city.test.ts` :: "never selects or returns PII (email/phone) — contact info only reaches context via llm_profile" | Also: `by design: lib/partners/types.ts:34-46` — `PartnerLite` has no email/phone fields in its type signature. `includeContactInShortlist: false` (see `tests/render-context.test.ts` :: "includeContactInShortlist=false strips exactly the labeled contact lines and nothing else") is a RENDERING preference, not a privacy guarantee — it strips only the labeled contact header lines (Adresse/Telefon/E-Mail/Social Media/Google Maps); contact mentions inside free-text profile prose (e.g. "## Kontakt & Anfahrt") survive either setting. PII safety itself is structural, per this row's `by design` note — email/phone are never selected into `PartnerLite` regardless of `includeContactInShortlist`. |
| E23 | RLS blocks access → server-side/service-role only | by design: architectural/infra — `lib/supabase.ts` (service-role client), not unit-testable without a live DB | Per `05-edge-cases.md` E23 itself: "Documented ... not testable in unit tests." |
| E24 | Vector search timeout → skip city, try next; home never skipped | unit test: `tests/tools/resolve-partners.test.ts` :: "skips a failing nearby city with a warning, still uses the next one (E24)"; "throws when the home fetch itself fails (hard error — home is never skipped)" | |
| E25 | Embedding service outage → text-only fallback + warning | unit test: `tests/tools/similarity-search-partners.test.ts` :: "degrades to text-only search when embedText throws, and returns a warning (E25)" | |
| E26 | Cost blowup guard: `k = gap + dedupHeadroom`, not a fixed large number | unit test: `tests/tools/resolve-partners.test.ts` :: "11) k passed to similaritySearchPartnersFn is gap + dedupHeadroom, and shrinks as gap closes (E26)" *(added this pass)* | Previously no test asserted the actual `k` value passed to the search function; only outcomes (which ids got included) were checked. |
| E27 | Non-deterministic results → stable tiebreaks, seeded overflow, fixed model | unit test: `tests/tools/resolve-partners.test.ts` :: "holds for: <scenario>" invariant #7 ("identical inputs produce identical outputs"), and `overflowTrim` :: "\"random-stable\": deterministic across repeated calls (no Math.random)" | |
| E28 | Home city has exactly `minPartners` → `>=` treated as enough, no gap-fill | unit test: `tests/tools/resolve-partners.test.ts` :: "1) home == minPartners exactly → no gap-fill (E28)" | |
| E29 | `maxCities = 1` → gap-fill loop never runs (strict single city) | unit test: `tests/tools/resolve-partners.test.ts` :: "3) maxCities == 1 → loop never runs; home only (E29)" | |
| E30 | No intent tags + `requireTagMatch=true` → tag filtering skipped, not empty | unit test: `tests/tools/similarity-search-partners.test.ts` :: "skips tag filtering when requireTagMatch=true but intent has zero tags — never returns empty just for that (E30)" *(added this pass)* | |
| E31 | User asks for more than `maxPartners` → guardrail still applies, agent discloses top N | LLM-behavior: instructions.md rule 4 ("Be honest about shortfalls... Conversely, if the working set was capped at the maximum (`meta.cappedAtMax` / more matches exist than were used), say so too — e.g. \"showing the top 5 of 40 available\"") | The code guardrail itself (`maxPartners` cap) IS tested — see E14. Final review wave added the explicit disclosure rule to instructions.md rule 4, closing the documentation gap previously recorded here; reclassified from GAP accordingly. |

## Counts

Each row is counted once, under its primary/testable classification (several
rows — E4, E19, E22 — also carry a secondary LLM-behavior or by-design note
in their "Notes" column, but are counted only once here so the total sums to 31):

- unit test: 27 (E2, E3, E4, E6, E7, E8, E9, E10, E11, E12, E13, E14, E15, E16, E17, E18, E19, E20, E21, E22, E24, E25, E26, E27, E28, E29, E30)
- by design: 2 (E5, E23)
- LLM-behavior: 2 (E1, E31)
- GAP: 0
- **Total: 31**

## Resolved since M8

**E31 — no instructions.md rule for "user asks for more than maxPartners" disclosure.**
Fixed in the final review wave: `agent/instructions.md` rule 4 now explicitly
covers the overflow-disclosure case ("if the working set was capped at the
maximum... say so too") alongside the pre-existing shortfall case. E31 is
reclassified from GAP to LLM-behavior above, citing that rule. The
code-level guardrail (`maxPartners` cap via `overflowTrim`, tested under
E14) was already correct and enforced; only the documentation/prompt gap
has changed.

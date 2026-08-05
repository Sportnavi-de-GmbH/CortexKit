# Solution Analysis & Improvement Recommendations
## Sportnavi Partner Recommendation Bot ("Navio") — Production Readiness Review

**Reviewer:** Senior architecture / AI-systems review
**Date:** 2026-08-01
**Scope:** `partner-recommendation-agent/` (workflow #1) + Supabase project `yojraumefnjlzaitnskd`
**Method:** Source read of `agent/` and `lib/` + live verification against the production database and the live PostgREST API. Every finding below is labelled **VERIFIED** (reproduced against live systems) or **REASONED** (derived from source, not executed).

> Per `CLAUDE.md` §14.8 ("Verify, don't infer"), no claim in this document is taken from the repository's prose. Where this review contradicts `CLAUDE.md`, the live evidence is shown inline.

---

# ✅ Remediation status — applied 2026-08-01

The critical set and several high-severity findings have been **fixed and verified live**. Findings below retain their original analysis; this table records what changed.

| ID | Finding | Status | Verification |
|---|---|---|---|
| **C1** | `get_partner_profiles` `limit 10` → blank profiles | ✅ **Fixed** | 100 ids → **100 profiles, 0 empty** (was 10 / ~90 empty) |
| **C2** | PostgREST 1,000-row centroid truncation | ✅ **Fixed** | **646 cities** reachable (was 334 of 648) |
| **C3** | Six tables writable by `anon` | ✅ **Fixed** | RLS on + write grants revoked on all six |
| **H2** | `filters.tags` never passed → dead tag branch | ✅ **Fixed** | **8/20** rows carry `tag_overlap > 0` (was 0) |
| **H5** | Cache key omitted `intentText` | ✅ **Fixed** | Key + regression tests added |
| **H6** | Disclosure described the resolved set, not the shortlist | ✅ **Fixed** | Live: *"Showing 5 of 14 found"* with only shown cities named |
| **M3** (part) | N redundant embeddings per gap-fill | ✅ **Fixed** | Embedded once for the fan-out; 4 regression tests |
| **M7** (part) | 3 dead-tool references in `instructions.md` | ✅ **Fixed** | Rewritten to `find_partners` |
| **L1.9** | RLS disabled on 6 tables | ✅ **Fixed** | Promoted to C3, remediated |
| — | Silent short-return / empty-profile guards | ✅ **Added** | Warns on shortfall; drops profile-less partners |
| — | Rule #6 withheld public contact details | ✅ **Inverted** | Navio now includes address/phone/e-mail/website with every recommendation |

**Rule #6 rewrite (owner decision).** The prompt previously said *"Never reveal
PII… Even then, confirm first."* Partner contact details are public directory
information the partner published in order to be contacted, and reaching the
studio is the point of the product — so withholding them cost answer quality
for no privacy benefit. Rule #6 now requires them in every recommendation.

The half that was **strengthened**, not relaxed: contact details are bound by
the grounding mandate *more* strictly than prose is. Copy verbatim; never
guess, complete, correct, or supply from memory. A plausible-looking wrong
phone number is worse than a missing one — it sends a real person to the wrong
place, and the user cannot detect the error until it has already cost them.

Verified contact coverage (live), which is why the missing-field path is spelled
out rather than treated as an edge case:

| Field | Missing on 2,331 active partners |
|---|---|
| `website_url` | **0** — always at least one route through |
| `street` | 111 (5%) |
| `phone` | 354 (15%) |
| `email` | 579 (25%) |

All profiles print `Adresse:`/`Telefon:` labels regardless, filled with the
placeholder `not_available` — present in **96%** of profiles. Rule #6 therefore
also forbids echoing that token to the user (rule #9: never quote internals).
`includeContactInShortlist` must stay `true`; its doc comment now says so.

**Applied changes**

*Database (3 migrations):* `remove_limit_10_from_get_partner_profiles`, `add_city_centroids_rpc`, `lock_down_anonymous_writes` (also sets `search_path` on `slugify_tag`).

*Code:* `find-nearby-cities.ts` (RPC aggregate), `build-recommendations.ts` (hydration guard, drop empty profiles, disclosure from shortlist), `similarity-search-partners.ts` (pass tags, accept shared embedding), `resolve-partners.ts` (embed once), `search-cache.ts` + `find_partners.ts` (intent in key, clamp `finalRecommendations`), `observability.ts` + `render-context.ts` (new warning codes), `agent/instructions.md` (dead tool refs).

*Tests:* **210 → 227 passing**, typecheck clean. New: `scripts/verify-review-fixes.ts` re-runs the C1/C2/H2 assertions against live services.

**Still open — the highest-value remaining work:** H1 (degraded-embedding path returns zero partners), H3 (`rrf_score` discarded), H4 (FTS ANDs terms), M1 (`vec` CTE `limit 40`), M2 (config now measurable — see below).

---

## ✅ M6 / Phase 0 — the evaluation layer now exists

**LangSmith dataset `Navio Partner — Edge Cases v1`** (EU, id `4ff9a359-b491-44f3-ba30-b0a80a0add8c`, 10 examples) + 14 evaluators + a calibration harness. Full documentation: [`partner-recommendation-agent/evals/README.md`](partner-recommendation-agent/evals/README.md).

Every case is grounded in a fact **verified against the live database**, so "expected" is checkable rather than aspirational — e.g. München really has only 4 partners; `resolve_city_fuzzy('Neustadt')` really returns *Bad Neustadt* at 0.692, above the 0.6 ask-threshold.

**Metric tiers — only the first two gate.** Deterministic code evaluators (7), one *hybrid* grounding gate where an LLM extracts and **code decides**, and judge-only diagnostics (6) that carry self-preference bias and never gate.

### The evaluator hallucinated twice — and the suite caught both

This was the review's own first question, and the answer is worth recording.

| # | What the judge claimed | Reality | Cause | Fix |
|---|---|---|---|---|
| 1 | *"freiraum Dortmund is not in the source"* | **Real partner, id 16768, active** | Judge got `profileText.slice(0, 24000)` of a **~167,000-char** payload — it saw 14% and asserted absence from the rest | Scope, don't enlarge: give it the *complete* profile blocks of only the partners named. Unlocatable ⇒ `INCONCLUSIVE`, never a failure |
| 2 | *"FABRICATED: [McFit]"* | Agent said *"Möchtest du McFit speziell besuchen…?"* — echoing the **user's own word** in a clarifying question | Extractor conflated mention with endorsement | Separate `recommendedBusinesses` from `echoedFromUser`; anything present in a user turn is an echo regardless of the classifier |

Both are now pinned by calibration fixtures — one plants a partner *after* a large filler block so any truncating implementation fails immediately. **15/15 evaluators discriminate correctly.**

Five design rules fell out, and they generalize beyond this project:

1. **Never let a judge decide a verdict code can check.** Extraction is a fair LLM job; adjudication is not.
2. **Never hand a judge a truncated source and ask about absence.**
3. **An unverifiable case is `INCONCLUSIVE`, never a failure.**
4. **Infrastructure errors are excluded from the score, not folded into it** — otherwise a 429 is indistinguishable from a fabrication.
5. **Calibrate before trusting.** Neither failure above was visible until fixtures existed.

### First experiment — findings

Grounding held everywhere it was tested, including the München fabrication bait (4 real partners, 15 returned with borrowing, zero invented) and the uncovered-city dead end. One genuine agent defect surfaced:

**EC-07 — rule #9 violated inside a correct refusal.** Asked for raw internals, the agent refused properly but wrote *"…technische Felder wie Similarity-Scores oder „body_markdown" Rohtexte…"* — naming all three things it was declining to reveal, which confirms they exist. Rule #9 already forbade this; the rule was **purely negative** ("never confirm or use field names") and, per this repo's own §11 lesson that *negative instructions leak*, it has been rewritten to state what the model **must** do — answer in product vocabulary, never reuse a technical term the user introduced — with a worked example whose failing half is the observed answer.

> ⚠️ **M2 is now measurable for the first time.** With C1 fixed, a full-width Bochum search renders **100 profiles / 167,456 chars ≈ 41,900 tokens** per search. That figure was previously unobtainable because the config was measuring a pipeline that could only hydrate 10 profiles. **Any earlier conclusion about the wide-context experiment should be discarded and re-measured.**

---

# Executive Summary

The engineering *discipline* in this codebase is well above average. The deterministic pipeline in `lib/partners/` is genuinely well designed: injectable dependencies, no `Math.random`, id-ascending tiebreaks everywhere, a single canonical path for contact data, laundered warnings, a documented failure asymmetry (home = hard error, nearby = degrade). The consolidation from 17 tools to 2 and from 4 model steps to 2 was measured, justified, and correct. The history section in `CLAUDE.md` §11 — a cost optimization that nearly shipped a fabricating agent — reflects a team that has learned the right lesson.

**However, the system is not production-ready.** This review found **three critical defects that live evidence confirms are active right now**, and all three are invisible to every metric the project currently tracks. Two of them attack the product's stated core invariant ("honesty outranks helpfulness") from underneath — not by making the model lie, but by silently removing the data the model was told to be honest about.

| # | Critical finding | Status |
|---|---|---|
| **C1** | `get_partner_profiles` has a hardcoded **`limit 10`** in its function body. The pipeline requests 100 profiles and receives 10. The other 90 — all borrowed/nearby partners — reach the model with an **empty profile body**, silently. | **VERIFIED live** |
| **C2** | PostgREST's default **1,000-row cap** silently truncates the city-centroid query. **314 of 648 cities (48%) are invisible** to gap-fill, city centroids are computed from partial data, and the wrong map is cached for 24 hours. | **VERIFIED live** |
| **C3** | Six tables have **RLS disabled *and* `INSERT`/`UPDATE`/`DELETE` granted to `anon`** — including `tag_synonyms`, which `match_partners` reads at query time. Anyone with the public key can rewrite retrieval behaviour or delete rows. This is a **write-integrity** problem, not a privacy one. | **VERIFIED live** |

C1 is the most dangerous of the three in product terms. It recreates the exact conditions of the fabrication incident documented in `CLAUDE.md` §11: the model is handed a partner **name and city with no profile text**, while the system prompt instructs it to "read that partner's full profile and find a concrete, specific detail." A model given a name, an instruction to be specific, and no source text is a model being invited to invent — and unlike the §11 incident, this one produces normal-looking tool-call telemetry, so `app.tools_used` and `app.model_steps` both look healthy.

> **Scope note on partner contact data.** Partner `email`, `phone` and `street` are **public directory information by design** and are expected in agent responses. This review therefore does **not** treat their availability through `get_partner_profiles` (or their presence in `llm_profile`) as a defect. `includeContactInShortlist: true` is the correct setting. The remaining database-permission finding (C3) concerns **write** access only.

Beyond the critical three, retrieval quality is materially worse than the design intends: the hybrid ranking signal (`rrf_score`) is computed by the database and then **discarded** by application code; the tag-ranking branch is **dead** because `filters.tags` is never passed; the full-text branch **never fires** on realistic multi-word German intents; and the documented "degrade to text-only search" fallback returns **zero usable partners**.

**Overall production-readiness verdict: NOT READY.** Estimated remediation for the blocking set (C1–C3 plus the retrieval floor bug) is **2–3 engineering days**.

**System health scorecard**

| Dimension | Rating | Comment |
|---|---|---|
| Security & integrity | 🟠 **Weak** | Public write access to 6 tables, one of which steers retrieval. No privacy issue — partner contact data is intentionally public |
| Grounding / honesty | 🔴 **Critical** | 90% of shortlisted profiles arrive empty; disclosure can describe partners not shown |
| Retrieval quality | 🟠 **Poor** | RRF discarded, tag branch dead, FTS branch dead, degrade path returns nothing |
| Reliability | 🟠 **Weak** | Silent truncation in two places; no timeouts; no retries |
| Performance / cost | 🟡 **Unmeasured** | ~41k tokens of profile text per search under the active config; cost telemetry ~8× wrong |
| Scalability | 🟡 **Adequate now** | Fine at 2.3k rows; several hard walls at ~10× |
| Code quality & testability | 🟢 **Strong** | Clean seams, mocked unit suite, deterministic |
| Evaluation maturity | 🔴 **Absent** | 0 LangSmith datasets; local harness asserts a subagent that no longer exists |
| Documentation accuracy | 🟡 **Mixed** | Root `CLAUDE.md` is excellent; three other docs describe a dead architecture |

---

# Current Strengths

Worth stating plainly, because the recommendations below should not disturb these.

1. **The LLM is kept away from arithmetic.** Counting, deduping, ranking, capping and threshold enforcement all live in `lib/partners/` behind pure functions with injectable dependencies. This is the single best decision in the codebase and it is why the failures found here are *data* failures rather than *reasoning* failures.

2. **Determinism is real, not aspirational.** Every sort in `resolve-partners.ts` and `build-recommendations.ts` carries an id-ascending tiebreak. `stableHash()` ([resolve-partners.ts:310](partner-recommendation-agent/lib/partners/resolve-partners.ts#L310)) exists specifically to avoid `Math.random`. The concurrent gap-fill in [resolve-partners.ts:178-235](partner-recommendation-agent/lib/partners/resolve-partners.ts#L178-L235) uses `Promise.allSettled` and then *consumes results in nearest-first order*, so parallelism buys latency without costing determinism. That is a genuinely elegant piece of engineering.

3. **Failure asymmetry is deliberate and correctly implemented.** Home-city fetch failure is an uncaught hard error; nearby-city failure appends a warning and degrades ([resolve-partners.ts:102-107](partner-recommendation-agent/lib/partners/resolve-partners.ts#L102-L107) vs [:142-154](partner-recommendation-agent/lib/partners/resolve-partners.ts#L142-L154)). The product cannot silently substitute the wrong city.

4. **Warnings are laundered before reaching the model.** `WARNING_PHRASES` in [render-context.ts:76-87](partner-recommendation-agent/lib/partners/render-context.ts#L76-L87) maps internal strings (which may embed raw DB error text) to a fixed vocabulary. Raw errors and similarity scores cannot leak into user-facing prose through this path.

5. **Contact data flows through exactly one path, deliberately.** `PartnerLite` carries no `email`/`phone` fields and `SELECT_COLUMNS` ([get-partners-by-city.ts:33](partner-recommendation-agent/lib/partners/get-partners-by-city.ts#L33)) never selects them; contact details reach the model only inside the pre-rendered `llm_profile` of the final shortlist. Since partner contact data is public directory information, the value here is not privacy but **context hygiene** — one canonical, owner-approved rendering of contact details instead of two competing shapes the model could disagree with. `includeContactInShortlist: true` is correct and should stay.

6. **The grounding mandate is placed and worded correctly.** Putting "You do not know any partners. Not one." at the very top of `instructions.md`, before persona, is the right fix for the §11 failure. Rule #10's deliberate redundancy and worked example are justified by reproduced evidence and should not be "cleaned up."

7. **Observability never blocks the request path.** `emitResolutionEvent` wraps everything in try/catch and defers via `queueMicrotask` ([observability.ts:78-84](partner-recommendation-agent/lib/observability.ts#L78-L84)).

8. **The root `CLAUDE.md` is an unusually good engineering artifact** — it names its own drift risk, dates its claims, and explicitly tells readers not to trust it over source.

---

# Limitations and Issues

Each issue: **what**, **why**, **when**, **impact**, **fix**.

---

## 🔴 C1 — `get_partner_profiles` returns 10 rows for a 100-row request; the other 90 profiles arrive empty

**Severity: CRITICAL — this is a grounding/hallucination defect, not merely a data bug.**
**Status: VERIFIED live**

### What is the problem?

The RPC body ends with a hardcoded `limit 10`:

```sql
CREATE OR REPLACE FUNCTION public.get_partner_profiles(p_ids bigint[]) ...
AS $function$
  select p.id as partner_id, p.name as title, p.city, ... p.llm_profile, p.profile_data
  from public.partners p
  where p.id = any(p_ids) and p.is_active
  limit 10                                   -- ← hardcoded
$function$
```

Verified:

```sql
-- request 100 ids, receive 10
profiles_returned = 10   |   ids_requested = 100
```

`buildRecommendations` calls it with up to `finalRecommendations` ids — **100** under the active config ([build-recommendations.ts:112](partner-recommendation-agent/lib/partners/build-recommendations.ts#L112)) — and then falls back per-partner:

```ts
llmProfile: profile?.llmProfile ?? c.summary,   // build-recommendations.ts:130
```

### Why does it happen — and why the fallback makes it worse

The fallback `c.summary` behaves **completely differently** for the two partner sources:

| Source | `summary` origin | Result when hydration is missing |
|---|---|---|
| **home** | `cleanBody(r.body_markdown)` — `body_markdown` *is* selected by `getPartnersByCity` | Degraded but **real** text |
| **nearby** | `cleanBody(hit.body_markdown)` where `match_partners` **does not return `body_markdown`**, so it is hardcoded `null` ([similarity-search-partners.ts:103](partner-recommendation-agent/lib/partners/similarity-search-partners.ts#L103)) | **Empty string `""`** |

So every borrowed partner past the 10 hydrated rows is rendered by `renderTier2` as a header with **no body at all**:

```
# Partner 16463 — Studio Beispiel (Dortmund)   [nearby]
Borrowed from: Dortmund, ~15 km from Bochum
Similarity score: 0.42

                    ← nothing here
---
```

And no warning fires. The `catch` in [build-recommendations.ts:113-118](partner-recommendation-agent/lib/partners/build-recommendations.ts#L113-L118) only triggers on an RPC *error*; a truncated success is indistinguishable from a complete one.

### Impact — why this is a fabrication risk, not just a quality bug

The system prompt tells the model, for **each** pick:

> "Read that partner's full profile and find a concrete, specific detail — a named course, a phrase about who it's for, a unique feature… Prefer the specific over the general."

and the genericness check tells it to reject any answer that "would work for any user who typed the same city and activity."

A model handed a **business name, a city, a `[nearby]` tag, and zero profile text**, while under strong instruction to produce a specific, personalized, non-generic justification, is in precisely the state that produced the §11 incident — where the agent generated five confidently-described studios with invented details attributed to *"laut Profil"*. The difference is that §11 was caught because *zero* database searches ran. **Here the searches all run correctly**, the tool result is well-formed, `app.tools_used` is populated, and `app.model_steps` is 2. **Every health signal the project currently monitors reads green while the model is being fed blanks.**

Rule #10 is the only remaining defence, and rule #10 exists precisely because the eval proved the model applies it inconsistently field-by-field within a single message.

### Recommended fix

1. **Remove the `limit 10`** from the RPC. It is almost certainly a leftover from an early prototype. Nothing else about the function changes — the returned columns, including `email`/`phone`, stay exactly as they are:

```sql
CREATE OR REPLACE FUNCTION public.get_partner_profiles(p_ids bigint[])
RETURNS TABLE(partner_id bigint, title text, city text, street text, postal_code text,
              tags text[], courses_text text, body_markdown text, email text, phone text,
              website_url text, llm_profile text, profile_data jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  select p.id, p.name, p.city, p.street, p.postal_code, p.tags_norm, p.courses_text,
         p.body_markdown, p.email, p.phone, p.website_url, p.llm_profile, p.profile_data
  from public.partners p
  where p.id = any(p_ids) and p.is_active;   -- `limit 10` removed; no other change
$$;
```

  Guard the size instead of capping it silently: the caller already bounds `p_ids` by `finalRecommendations`, so add `.max(maxPartners)` on the tool argument (see H6) rather than a magic number inside the function.
2. **Make truncation loud** — a silent short-return must never happen again:

```ts
// build-recommendations.ts, after hydration
if (profiles.size < chosen.length) {
  warnings.push(
    `Profile hydration returned ${profiles.size} of ${chosen.length} requested profiles.`
  );
}
```
3. **Never emit a profile-less partner to the model.** Drop any recommendation whose resolved `llmProfile` is empty, and account for the drop in the disclosure. A partner the model cannot describe honestly is worse than one partner fewer.
4. Add a `classifyWarning` code (`hydration_incomplete`) and a `WARNING_PHRASES` entry so this surfaces in `renderMetaSummary` rather than only in logs.

---

## 🔴 C2 — PostgREST's 1,000-row cap silently truncates the city map; 48% of cities are invisible to gap-fill

**Severity: CRITICAL for product correctness (the partner-injection algorithm is the product).**
**Status: VERIFIED live**

### What is the problem?

`getCityCentroids` fetches every active partner's coordinates to build the city map ([find-nearby-cities.ts:83-89](partner-recommendation-agent/lib/partners/find-nearby-cities.ts#L83-L89)):

```ts
const { data, error } = await supabase.from("partners")
  .select("city, latitude, longitude")
  .eq("is_active", true)
  .not("latitude","is",null).not("longitude","is",null).not("city","is",null);
```

There is no `.range()` and no pagination. Supabase/PostgREST applies a **default `db-max-rows` of 1,000**.

### Verified

```
Content-Range: 0-0/2331          ← 2,331 rows exist
ROWS RETURNED:      1000         ← 1,000 rows delivered
DISTINCT CITIES:     334         ← out of 648
identical order across runs: true   (deterministic, therefore permanently invisible)
```

Cross-checked in SQL:

```
cities_in_window              334
cities_total                  648
partners_in_invisible_cities  471
```

### Why does it happen?

PostgREST caps unbounded selects to protect the API. The client library does not warn — a truncated response is a normal HTTP 200 array. The code even contains a "defense in depth" filter for null coordinates ([find-nearby-cities.ts:102-105](partner-recommendation-agent/lib/partners/find-nearby-cities.ts#L102-L105)) — careful about the wrong failure mode.

### When does it appear?

**On every gap-fill, which under the active config (`minPartners: 100`) is every search except Bielefeld.** The result is cached for **24 hours** (`neighborsCacheTtlSec: 86_400`), so a single truncated fetch poisons an entire day of searches. Because the row order is deterministic, the *same* 314 cities are excluded every time — this is not intermittent, it is a permanent blind spot.

### Impact

Three distinct correctness failures compound:

1. **314 cities can never be borrowed from.** 471 partners are unreachable via gap-fill regardless of how close they are to the user.
2. **Centroids of *included* cities are computed from a partial partner set** — a city whose partners straddle the 1,000-row boundary gets a centroid derived from only the rows that made it in. Every Haversine distance from that city is then wrong, so `maxDistanceKm: 150` filters and nearest-first ordering are both applied to corrupted geometry.
3. **`availableCount` is understated**, degrading the `b.availableCount` tiebreak in the sort at [find-nearby-cities.ts:180-185](partner-recommendation-agent/lib/partners/find-nearby-cities.ts#L180-L185).

The user-facing symptom is the product's core promise inverted: Navio says "coverage near X is limited" and offers a partner 90 km away while a closer one sits in an invisible city. The disclosure is *honestly reporting a number the pipeline computed wrongly*.

### Recommended fix

Do the aggregation **in the database**, not in JS. This removes the row cap, removes the 2,300-row transfer, and fixes the alias-collapsing at the same time:

```sql
CREATE OR REPLACE FUNCTION public.city_centroids()
RETURNS TABLE(city text, lat float8, lon float8, cnt int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select
    (array_agg(p.city order by cnt_per_spelling desc, p.city))[1] as city,
    avg(p.latitude)::float8, avg(p.longitude)::float8, count(*)::int
  from (
    select city, latitude, longitude,
           count(*) over (partition by city) as cnt_per_spelling,
           public.slugify_tag(city) as key
    from partners
    where is_active and city is not null
      and latitude is not null and longitude is not null
  ) p
  group by p.key;
$$;
-- grant to service_role only
```

Then replace the JS grouping in `getCityCentroids` with one `.rpc("city_centroids")` call.

**Interim mitigation if the migration must wait:** paginate explicitly with `.range()` in a loop, and — critically — **assert the row count** against a `count=exact` header so a future truncation fails loudly instead of silently.

**Systemic lesson:** audit every unbounded `.select()` in the codebase. `getPartnersByCity` is safe today only because the largest city has ~100 partners; at 10× the data it hits the same wall, and the golden rule ("the home city is taken whole") would be silently violated.

---

## 🔴 C3 — Six tables accept writes from anyone holding the public anon key

**Severity: CRITICAL for data integrity. This is a *write* problem, not a privacy problem.**
**Status: VERIFIED live**

### What is the problem?

Partner data being publicly *readable* is intentional. Being publicly *writable* is not. Six tables have RLS disabled **and** carry `INSERT`/`UPDATE`/`DELETE` grants for the `anon` role, so the public key is a write credential for them:

| Table | RLS | anon SELECT | anon INSERT/UPDATE/DELETE |
|---|---|---|---|
| `tag_synonyms` | ❌ off | ✅ | ✅ **writable** |
| `okf_profiles` | ❌ off | ✅ | ✅ **writable** |
| `raw_pages` | ❌ off | ✅ | ✅ **writable** |
| `partners_backup_20260719` | ❌ off | ✅ | ✅ **writable** |
| `checkpoints`, `checkpoint_writes`, `checkpoint_blobs`, `checkpoint_migrations` | ❌ off | ✅ | ✅ **writable** |
| `partners`, `partner_intelligence`, `courses` | ✅ on, no policies | blocked | blocked ✅ |

`partners` itself is safe: RLS is enabled with no policies, so the grants are inert. The six above have no such protection.

### Why it matters more than it looks

`tag_synonyms` is **not** an inert lookup table. `match_partners` reads it at query time to expand the caller's tags into canonical slugs:

```sql
select ts.canonical_slug from qraw join public.tag_synonyms ts on ts.variant_slug = qraw.slug
```

So anyone with the public key can rewrite the synonym map and thereby **steer which partners the recommendation engine surfaces** — or delete all 89 rows and silently degrade tag expansion. That is retrieval manipulation through a public endpoint, and nothing in the application would report it: results would simply change.

`partners_backup_20260719` is a full snapshot of the directory that can be **dropped row-by-row** by an anonymous caller — the loss of a recovery asset.

The `checkpoint_*` tables are LangGraph/agent state; writable checkpoint state is a state-poisoning surface if anything ever reads from it.

### When does it appear?

Now, for anyone who has the anon key — which is public by construction, since it is designed to ship inside client applications. Supabase's advisor already flags all six as `rls_disabled_in_public` at **ERROR** level.

### Recommended fix

Do **not** enable RLS without policies on tables the application reads with a non-service-role key — that blocks all access silently. The correct shape here is: enable RLS, then add an explicit read-only policy where public reads are wanted.

```sql
-- tag_synonyms: public reads are fine (and match_partners runs SECURITY DEFINER anyway);
-- public writes are not.
ALTER TABLE public.tag_synonyms ENABLE ROW LEVEL SECURITY;
CREATE POLICY tag_synonyms_read ON public.tag_synonyms FOR SELECT TO anon, authenticated USING (true);
REVOKE INSERT, UPDATE, DELETE ON public.tag_synonyms FROM anon, authenticated;

-- Internal tables: no public access at all.
ALTER TABLE public.raw_pages                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partners_backup_20260719  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.checkpoints               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.checkpoint_writes         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.checkpoint_blobs          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.checkpoint_migrations     ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.raw_pages, public.partners_backup_20260719,
              public.checkpoints, public.checkpoint_writes,
              public.checkpoint_blobs, public.checkpoint_migrations
  FROM anon, authenticated;

-- okf_profiles holds opening_hours for 335 partners — public-read, no public write.
ALTER TABLE public.okf_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY okf_profiles_read ON public.okf_profiles FOR SELECT TO anon, authenticated USING (true);
REVOKE INSERT, UPDATE, DELETE ON public.okf_profiles FROM anon, authenticated;
```

The agent uses the **service-role** key exclusively ([supabase.ts:38](partner-recommendation-agent/lib/supabase.ts#L38)), which bypasses RLS — so none of this affects Navio. Verify against any *other* client that talks to this project before applying.

Also worth doing while in here: add `SET search_path` to `public.slugify_tag` (advisor: `function_search_path_mutable`). A mutable `search_path` on a function reachable from a `SECURITY DEFINER` call chain is a privilege-escalation primitive, independent of what data is public.

---

## 🟠 H1 — The documented "degrade to text-only search" fallback returns zero partners

**Severity: HIGH. Status: VERIFIED live.**

When the embedding API is unavailable, `similaritySearchPartners` catches the failure, pushes an `embedding_degraded` warning, and proceeds with `query_embedding: null` ([similarity-search-partners.ts:70-78](partner-recommendation-agent/lib/partners/similarity-search-partners.ts#L70-L78)). Inside `match_partners`, the `vec` CTE degrades to a no-op and every returned row has `similarity = NULL`. Application code maps `null → 0` ([:104](partner-recommendation-agent/lib/partners/similarity-search-partners.ts#L104)), and `resolve-partners.ts` then rejects everything below `similarityThreshold` (0.15):

```sql
select count(*) rows_returned, count(similarity) with_similarity,
       count(*) filter (where coalesce(similarity,0) >= 0.15) would_pass_floor
from match_partners(null,'yoga entspannung anfänger','{"city":"Bielefeld"}',120);

rows_returned = 40 | with_similarity = 0 | would_pass_floor = 0
```

**The user receives a reassuring "search quality was degraded" message and not one borrowed partner.** The fallback is worse than useless: it consumes the full latency of 10 concurrent RPC calls, produces a warning implying partial success, and returns nothing. This is a graceful-degradation path that does not degrade gracefully.

**Fix:** when `queryEmbedding === null`, rank by `rrf_score` (which is still meaningful — the `kw` and `nm` branches populate it) and **bypass the cosine floor entirely** for that call. Mark those hits with a `degraded: true` flag so the disclosure can say so honestly. Add a unit test that asserts the degraded path returns > 0 partners.

---

## 🟠 H2 — `filters.tags` is never passed, so the tag branch is dead and `requireTagMatch` is a footgun

**Severity: HIGH (latent config landmine). Status: VERIFIED live.**

`similaritySearchPartners` passes only `filters: { city: input.city }` ([similarity-search-partners.ts:84](partner-recommendation-agent/lib/partners/similarity-search-partners.ts#L84)). Inside `match_partners`, the `tg` CTE is guarded by `where cardinality(qtags.slugs) > 0` — with no `tags` key, `qtags.slugs` is empty, the CTE returns nothing, and **`tag_overlap` is `NULL` for every row**:

```sql
select count(*) rows, count(tag_overlap) rows_with_tag_overlap,
       count(*) filter (where coalesce(tag_overlap,0)>0) would_survive_requireTagMatch
from match_partners(null,'yoga','{"city":"Bielefeld"}',40);

rows = 40 | rows_with_tag_overlap = 0 | would_survive_requireTagMatch = 0
```

Two consequences:

1. **One of the four RRF ranking branches is permanently dead.** The database implements tag-overlap ranking (including `tag_synonyms` and `okf.tag_variants` expansion — 89 synonym rows) and the application never activates it. The model's carefully-extracted `tags` argument does nothing for gap-fill.
2. **Setting `requireTagMatch: true` silently zeroes out gap-fill.** The client-side filter `rows.filter(r => (r.tag_overlap ?? 0) > 0)` ([:94](partner-recommendation-agent/lib/partners/similarity-search-partners.ts#L94)) removes **100%** of nearby candidates. Home-city tag filtering still works (it uses `.overlaps()`), so the failure is asymmetric and would present as "gap-fill mysteriously stopped working." It is a documented, typed, presettable config dial that breaks the product.

**Fix (one line):**
```ts
filters: { city: input.city, ...(input.intent.tags.length ? { tags: input.intent.tags } : {}) },
```
Then add a regression test asserting `tag_overlap` is non-null when tags are supplied, and a `validateConfig` guard rejecting `requireTagMatch: true` until the fix is verified.

---

## 🟠 H3 — The hybrid ranking signal is computed and then thrown away

**Severity: HIGH. Status: VERIFIED (source + RPC definition).**

`match_partners` orders its output by `rrf_score desc, g.id` — a Reciprocal-Rank-Fusion of four branches (vector, full-text, name-trigram, tag-overlap). This is the ranking the database was built to provide.

Application code maps only `similarity` and **never reads `rrf_score`** ([similarity-search-partners.ts:97-105](partner-recommendation-agent/lib/partners/similarity-search-partners.ts#L97-L105); `SimilarityHit` in [types.ts:73-81](partner-recommendation-agent/lib/partners/types.ts#L73-L81) has no `rrf` field). Then `resolve-partners.ts` applies a cosine floor to it, and `build-recommendations.ts` re-sorts by that same raw cosine — discarding the RPC's ordering entirely.

The consequence is visible in the config file's own comment: `similarityThreshold` had to be dropped from 0.35 to 0.15 because "nearly every borrowed partner was rejected." That is the symptom of thresholding the wrong metric. Raw cosine over `text-embedding-3-small` German profile text is poorly calibrated for an absolute cutoff; RRF rank is exactly the signal that *is* comparable across queries.

**Fix:** carry `rrf_score` through `SimilarityHit`; rank and threshold on it; keep `similarity` for display only. Expect to retune or remove `similarityThreshold` afterwards — a rank-based cutoff (`top-k`) is more robust than a score-based one.

---

## 🟠 H4 — The full-text branch never fires on real German intents

**Severity: HIGH. Status: VERIFIED live.**

`match_partners` uses `websearch_to_tsquery('german', query_text)`, which **ANDs** all terms. The prompt explicitly instructs the model to carry the user's driver forward *verbatim* into `intentText` — producing exactly the multi-word strings that fail:

```sql
'yoga'                              → 19 matches in Bielefeld
'yoga entspannung anfänger'         →  0 matches   (parses to 'yoga' & 'entspann' & 'anfang')
'sanft wieder einsteigen fitness'   →  0 matches
```

So the better the model follows the intent-decomposition instructions, the more certainly the FTS branch contributes nothing. Combined with H2 (tag branch dead) and H3 (RRF discarded), the "hybrid" search is in practice **vector-only** — which is also why H1 leaves nothing at all.

**Fix:** OR the terms and let RRF weigh them — `to_tsquery('german', array_to_string(terms,' | '))`, or `websearch_to_tsquery` with the query rewritten to `or` form. Keep the AND variant as an additional high-precision branch if desired.

---

## 🟠 H5 — Search-cache key omits `intentText`, so different requests share one answer

**Severity: HIGH (correctness + honesty). Status: REASONED from source.**

The cache key is `(cityMention, sorted tags, finalRecommendations)` ([search-cache.ts:44-52](partner-recommendation-agent/lib/partners/search-cache.ts#L44-L52)). `intentText` is deliberately excluded, with this justification:

> "intentText is used solely as the embedding query during gap-fill."

That justification is exactly backwards. `intentText` **is** the embedding query, and the embedding query determines which partners gap-fill selects. It is the single strongest input to the nearby result set.

`tags` is model-supplied and frequently empty (nothing forces the model to populate it). Concretely:

| Turn | `cityMention` | `tags` | `intentText` | Cache key |
|---|---|---|---|---|
| 1 | Bochum | `[]` | "Kletterkurse für Anfänger" | `bochum::::100` |
| 2 | Bochum | `[]` | "Yoga zum Stressabbau" | `bochum::::100` ← **same** |

Turn 2 is served turn 1's climbing partners, for up to an hour, with turn 1's disclosure text. The model then writes a warm, specific, *fabrication-adjacent* justification for why climbing gyms suit a stress-relief request — grounded in a tool result that is real but answers a different question. This defeats the entire intent-decomposition section of the prompt.

**Fix:** include a normalized hash of `intentText` in the key. Cache hit-rate will drop; that is the correct trade. If hit-rate matters, cache the *home-city fetch* (which genuinely does not depend on intent) separately from the *gap-fill*, rather than caching the whole search under a key that omits its main input.

**Secondary:** the key uses the raw `cityMention`, so `Köln` / `koeln` / `Cologne` occupy three entries for one canonical city — cache the resolved canonical name instead.

---

## 🟠 H6 — The disclosure describes the resolved set, not the shortlist actually shown

**Severity: HIGH when triggered (direct honesty-invariant violation). Status: REASONED from source.**

`buildDisclosure` computes its counts from `set.home.length` and `set.filled.length` — the **pre-truncation** resolved set ([build-recommendations.ts:171-196](partner-recommendation-agent/lib/partners/build-recommendations.ts#L171-L196)) — while the model is shown `chosen = ranked.slice(0, n)` ([:103](partner-recommendation-agent/lib/partners/build-recommendations.ts#L103)).

Because `ranked` is `[...home, ...rankedFilled]`, home partners always fill the shortlist first. So whenever `finalRecommendations < home.length + filled.length`, the disclosure claims borrowed partners that **do not appear in the list**:

> "Partners: 60 in Bochum; 40 nearby from Dortmund, Essen (~12 km)."
> …while the model was shown 5 partners, all from Bochum.

`finalRecommendations` is an **optional, model-controlled tool argument** with no upper bound and no clamp ([find_partners.ts:77-82](partner-recommendation-agent/agent/tools/find_partners.ts#L77-L82)). Rule #3 of the system prompt actively encourages the model to narrow ("curate a small selection rather than dumping a long list"), so a model passing `finalRecommendations: 5` is *following instructions* — and triggering the bug.

The default (100 = `maxPartners`) masks it today, which is why it has not been noticed.

**Fix:** compute the disclosure from `chosen`, not from `set`. Report the resolved-set totals separately and explicitly (`"…aus 40 verfügbaren"`), which is also what rule #5 asks for. Clamp `finalRecommendations` to `maxPartners` in the tool.

---

## 🟡 M1 — `match_partners` caps its vector branch at 40 rows; `k` above 40 is meaningless

**Status: VERIFIED (RPC body: `vec … limit 40`).**

`resolve-partners.ts` requests `k = initialGap + dedupHeadroom` — under the active config, `100 + 20 = 120`. The `vec` CTE returns at most 40. `dedupHeadroom: 20` on a gap of 100 therefore buys nothing, and no single nearby city can ever contribute more than ~40 candidates. Combined with `maxCities: 10`, the theoretical ceiling on gap-fill is ~360 candidates before dedup — but with C2 removing half the candidate cities, effective supply is far lower.

**Fix:** parameterize the CTE limits as `greatest(match_count, 40)` (or `match_count * 2`), and make `dedupHeadroom` proportional rather than absolute.

---

## 🟡 M2 — The wide-context test profile is expensive, unmeasured, and interacts badly with C1

**Status: VERIFIED (measurement below).**

`DEFAULT_CONFIG` is a documented experiment (`100 / 100 / 10 / 100`). Measured profile sizes:

```
avg_chars 1,636 | p50 1,520 | p95 2,634 | max 20,235
⇒ 100 full profiles ≈ 163,600 chars ≈ 41,000 tokens per search
```

Consequences:
- ~41k tokens of **tool-result** payload per search, on top of the ~11k-token stable prefix. Tool results are not prefix-cached, so this is billed at full input rate every search — plausibly the dominant cost line, and it is not what the 93% cache-hit metric measures.
- A single 20k-char outlier profile can add ~5k tokens alone. There is no per-profile cap (`renderTier2` is untruncated by design).
- The Tier-1/Tier-2 distinction collapses: `renderTier1` is dead code on the production path.
- **The interaction with C1 is the real problem:** the config asks for 100 profiles, the RPC delivers 10. The experiment is currently measuring a configuration that cannot work. **Any conclusion drawn from this profile before C1 is fixed is invalid.**

**Fix:** fix C1 first, then re-run the comparison. Recommend `WIDE_NET` or a tuned middle profile as the shipping default; `finalRecommendations: 100` is not a user-facing requirement (the model curates ~5 anyway per rule #3), so paying 41k tokens to render 100 profiles the user never sees is waste. Add a p95 truncation guard for outlier profiles.

---

## 🟡 M3 — No timeouts, no retries, and an 8-second hard database ceiling

**Status: VERIFIED (role config) + REASONED.**

`pg_roles` shows `authenticator` carries `statement_timeout=8s` and `lock_timeout=8s`. Every PostgREST query — including the 10 concurrent `match_partners` calls — dies at 8 s with no application-level handling.

Meanwhile the application sets **no timeout at all** on: the embedding HTTP call (`fetch` in [embeddings.ts:57](partner-recommendation-agent/lib/embeddings.ts#L57), no `AbortSignal`), any Supabase call, or the model call. A hung embedding provider blocks a `find_partners` execution indefinitely — and it happens **10× concurrently** during gap-fill, since `similaritySearchPartners` embeds per city.

Note also: `embedText` is called once per nearby city with the *same* `intent.text`. The in-process cache in [embeddings.ts:14](partner-recommendation-agent/lib/embeddings.ts#L14) is populated only *after* the first call resolves, so 10 concurrent calls all miss and issue **10 identical embedding requests**. This is pure waste on every gap-fill.

**Fix:**
- Add `AbortSignal.timeout(5000)` to the embedding fetch; wrap Supabase calls in a timeout helper.
- **Embed once, before the fan-out**, and pass the vector into `similaritySearchPartners` (removes 9 redundant API calls and 9 failure points per search).
- Add in-flight request coalescing to the embedding cache (store the promise, not the result).
- Add one bounded retry with jitter for transient 5xx/429 on embeddings.

---

## 🟡 M4 — Scaling walls in the data layer

**Status: VERIFIED.**

- **No index on `partners.city`.** `getPartnersByCity` filters on it, and `resolve_city_fuzzy` computes `similarity(slugify_tag(city), …)` over every active row with no expression index. Currently a 2.7 ms seq scan (measured) — irrelevant at 2.3k rows, linear thereafter.
- **The HNSW index has never been used.** `match_partners` pre-filters by city inside the `base`/`geo` CTEs, forcing an exact scan in `vec`. Confirmed by Supabase's advisor. At 10× data this becomes the dominant cost.
- **`partners_tags_norm_idx` is also unused** (consequence of H2 — the tag branch never runs).
- **`partner_intelligence` has no FK to `partners`**, forcing a manual second query in `getPartnersByCity` ([:71-77](partner-recommendation-agent/lib/partners/get-partners-by-city.ts#L71-L77)) — an extra round-trip on every search and no referential integrity.

**Fix (in order):** `CREATE INDEX partners_city_idx ON partners (city);` and an expression index on `slugify_tag(city)`; add the FK; restructure `match_partners` to push the city filter down so HNSW is usable (or accept exact scan and document the ceiling).

---

## 🟡 M5 — In-process state prevents horizontal scaling

**Status: REASONED.**

Three caches are module-level singletons: the search cache (500 entries / 1 h), the centroid cache (24 h), and the embedding cache (unbounded `Map` — [embeddings.ts:14](partner-recommendation-agent/lib/embeddings.ts#L14), never evicted, a slow memory leak in a long-lived process).

With N instances: hit rates divide by N, `invalidateSearchCache()` reaches only one instance, and the 24-hour centroid map means **different instances can serve different city maps for a full day** after a partner import. Users get non-reproducible answers depending on routing.

**Fix:** move to Redis or accept single-instance deployment explicitly. Bound the embedding cache. Add a cross-instance invalidation channel before scaling out.

---

## 🟡 M6 — Evaluation is absent, and cost telemetry is wrong by ~8×

**Status: VERIFIED (grep + `CLAUDE.md` measurement).**

- **LangSmith has 0 datasets.** The evaluation platform described in `project-prompts/` is intended, not built.
- The local harness `tests/agent-test/` has 30 cases, but **7 still assert "Curator was used"** — the `partner-curator` subagent was deleted. Those cases score a deleted component and cannot pass.
- LangSmith cost is inflated ~8× by two multiplicative errors (`invoke_agent` double-counting ×2; prompt-cache discount ignored ×~3.4). Usable as a relative regression signal only.
- **The 93% cache-read share is unmonitored** despite being the highest-leverage cost metric. Any per-request content entering the prefix would quietly multiply the bill ~4×.
- **Critically: none of the current health signals would have caught C1, C2 or C3.** `app.tools_used` is populated, `app.model_steps` is 2, resolution events fire. All green, all three bugs active.

**Fix:** this is Phase 0 and it genuinely blocks everything else. Minimum viable eval:
1. **Grounding check** — every business name in the answer appears in the tool result. *(Catches §11 and C1.)*
2. **Profile-completeness check** — every partner rendered to the model has a non-empty profile. *(Catches C1 directly.)*
3. **Disclosure-accuracy check** — stated counts match the shortlist. *(Catches H6.)*
4. **Rule-#10 honesty case** — hours + price asked together; both must be declined.
5. **Borrowed-city disclosure** and **clarifying-question** paths.
Fix the 7 curator assertions before migrating the dataset to LangSmith.

---

## 🟡 M7 — Prompt drift, doc drift, and a live key on disk

**Status: VERIFIED (grep).**

`instructions.md` still names **tools that do not exist**, at 5 locations:

| Line | Text |
|---|---|
| 103–104 | "`find_partners` already does internally what `extract_city` → `resolve_partners` → `build_recommendations` used to do" |
| **139** | "pass it straight to **`extract_city`**" |
| **257** | rule #8: "If **`extract_city`** returns low confidence…" |
| **338** | follow-up rule #3: "Never re-run **`resolve_partners`**…" |

Lines 103–104 are harmless history. **Lines 139, 257 and 338 are live instructions naming non-existent tools.** §11 documents precisely this class of ambiguity causing a fabricating agent: the model reads an instruction it cannot execute and generalizes unpredictably. Rule #8 is a *safety* rule — telling the model to consult a tool that does not exist weakens the ambiguity path.

Fix by **rewriting to name `find_partners`**, never by deleting the rules.

Also: `README.md` and `.eve/agent-summary.json` describe the dead 9-tool architecture; and a **live LangSmith API key sits in `.mcp.json`** — gitignored deliberately, so contained, but rotate it if that file was ever shared.

---

## 🟢 L1 — Lower-severity observations

| # | Observation | Impact |
|---|---|---|
| L1.1 | The dev console (`app/`) has **no authentication** and proxies `/eve/v1/*` to the agent. Fine locally; a deployment exposes an unauthenticated LLM endpoint (cost-drain + prompt-injection surface). | Med if deployed |
| L1.2 | `get_partner_details(partnerId)` accepts **any** positive integer with no check that the partner was previously shown. Not a disclosure issue — the directory is public — but it lets a prompt-injected turn pull a partner into context that no search returned, weakening the grounding chain. | Low |
| L1.3 | The `aliases.length === 0` branch in `buildDisclosure` ([:172](partner-recommendation-agent/lib/partners/build-recommendations.ts#L172)) is **unreachable** on the live path — `resolveCityFuzzy` always returns `aliases: [best.city]`. Dead code that looks like a safety net. | Low |
| L1.4 | `resolve_city_fuzzy` returns **at most one row** with a `sim > 0.4` floor. "Neustadt" (many real German towns) silently resolves to exactly one, with no disambiguation offered. `cityConfidenceMin: 0.6` catches only weak matches, not *ambiguous strong* ones. | Med (UX) |
| L1.5 | Cached search results are returned **by reference** ([find_partners.ts:104](partner-recommendation-agent/agent/tools/find_partners.ts#L104)). Nothing mutates them today; any future mutation corrupts the cache for all subsequent callers. | Low (latent) |
| L1.6 | `normalizeCityKey` collapses umlaut spelling variants into one label, but `match_partners` filters `lower(p.city) = lower(filters->>'city')` — an **exact** match. If spelling variants ever appear, the non-canonical spellings become unsearchable. Verified: **no variants exist today** (0 rows), so this is latent, not active. | Low (latent) |
| L1.7 | `embedText` cache is keyed by SHA-256 of text with **no size bound** — unbounded growth over process lifetime. | Low |
| L1.8 | 18 active partners have empty `tags_norm`; they are invisible to any tag-based path (currently harmless because H2 makes tag paths dead anyway). | Low |
| L1.9 | *Promoted to **C3** during review — six tables accept anonymous writes.* | — |
| L1.10 | `emitResolutionEvent` mints its own `crypto.randomUUID()` ([find_partners.ts:142](partner-recommendation-agent/agent/tools/find_partners.ts#L142)) rather than using the eve request id, so resolution events cannot be joined to traces. | Low (observability) |
| L1.11 | eve still provisions a Docker sandbox per turn despite all sandbox-backed tools being disabled (17 opens measured; one took 5 s). Unresolved upstream. | Low–Med (latency) |

---

# Edge Cases

Scenario → current behaviour → risk → recommendation. **V** = verified live, **R** = reasoned from source.

## User queries

| # | Scenario | Current behaviour | Risk | Recommendation |
|---|---|---|---|---|
| U1 | Same city, no tags, **different activity** within 1 h | Serves the first query's cached partners (H5) | 🔴 | Include `intentText` in the cache key |
| U2 | Ambiguous city ("Neustadt", "Frankfurt") | Silently picks one; `sim` often > 0.6 so no clarification (L1.4) | 🟠 | Return top-3 candidates; ask when the top two are within ~0.05 |
| U3 | Multi-part question ("hours **and** prices") | Rule #10 mitigates; eval reproduced the failure **twice** | 🟠 | Keep rule #10 verbatim; add as an eval gate |
| U4 | Multi-word German driver ("sanft wieder einsteigen") | FTS branch returns 0 (H4, **V**); vector-only | 🟠 | OR the FTS terms |
| U5 | No city mentioned | `needsClarification` + guided choice — **works well** | 🟢 | None |
| U6 | Two cities in one message ("Bochum oder Dortmund") | Model picks one arbitrarily; no contract for it | 🟡 | Either search both and merge, or ask |
| U7 | Prompt injection inside `body_markdown`/`llm_profile` | Rule #7 only; profile text is **passed verbatim** into context | 🟠 | Add structural delimiters + an injection eval case |
| U8 | Out-of-scope request ("book me a class") | Undefined — no capability boundary in the prompt | 🟡 | Add an explicit "what Navio cannot do" section |
| U9 | Very long conversation | eve compaction may drop earlier profiles; rule #2 handles via `get_partner_details` | 🟡 | Add a long-conversation eval case |
| U10 | Model passes `finalRecommendations: 5` | Disclosure describes 100 partners, 5 shown (H6, **R**) | 🟠 | Derive disclosure from `chosen`; clamp the argument |

## Data

| # | Scenario | Current behaviour | Risk | Recommendation |
|---|---|---|---|---|
| D1 | Shortlist > 10 partners | **Only 10 hydrated; nearby partners render blank** (C1, **V**) | 🔴 | Remove `limit 10`; warn on short returns; drop empty profiles |
| D2 | > 1,000 active partners with coords | **Centroid map truncated; 314 cities invisible** (C2, **V**) | 🔴 | Aggregate in SQL via `city_centroids()` |
| D3 | City with > 1,000 partners | `getPartnersByCity` would truncate silently; golden rule violated | 🟡 | Paginate + assert count |
| D4 | Partner with 20k-char profile | Rendered untruncated (~5k tokens alone) | 🟡 | p95 truncation guard |
| D5 | City spelling variants appear | Non-canonical spellings unsearchable (L1.6) | 🟡 | Slugify the city filter in `match_partners` |
| D6 | Partner with no tags (18 exist, **V**) | Invisible to tag paths | 🟢 | Backfill |
| D7 | Import runs mid-day | Up to 1 h stale shortlists, 24 h stale centroids, per instance | 🟡 | Call `invalidateSearchCache()`; shared cache |
| D8 | Empty / brand-new city | `needsClarification` — correct | 🟢 | None |

## AI behaviour

| # | Scenario | Current behaviour | Risk | Recommendation |
|---|---|---|---|---|
| A1 | Model receives a name with **no profile text** | Under instruction to be "specific"; §11 conditions recreated (C1) | 🔴 | Never render a profile-less partner |
| A2 | Model answers without calling the tool | Grounding mandate is the only guard; **no automated check** | 🔴 | Grounding evaluator (Phase 0) |
| A3 | Model quotes internals (`body_markdown`) | Rule #9 only | 🟡 | Eval case |
| A4 | Model states hours/prices not in the profile | Rule #10; reproduced twice historically | 🟠 | Eval gate |
| A5 | Model tries a disabled tool | `disableTool()` — safe | 🟢 | None |
| A6 | Model sets an absurd `finalRecommendations` | Unbounded `z.number().int().positive()` | 🟡 | `.max(maxPartners)` |

## System

| # | Scenario | Current behaviour | Risk | Recommendation |
|---|---|---|---|---|
| S1 | Embedding API down | Warns, then returns **zero** partners (H1, **V**) | 🟠 | Fall back to `rrf_score`, bypass the floor |
| S2 | Embedding API **hangs** | No timeout; ×10 concurrent (M3) | 🟠 | `AbortSignal.timeout`; embed once |
| S3 | Supabase 8 s statement timeout | Home fetch → hard error (correct); nearby → skipped (correct) | 🟢 | Add app-level timeout < 8 s for a cleaner message |
| S4 | Anon key used instead of service-role | Silent empty results | 🟠 | Startup assertion that a search returns > 0 rows |
| S5 | Concurrent identical searches (cold cache) | Full duplicate work; no coalescing | 🟡 | Single-flight the cache |
| S6 | Multi-instance deployment | Divergent caches; invalidation reaches one instance (M5) | 🟠 | Shared cache before scaling |
| S7 | Anon key holder rewrites `tag_synonyms` | **Write succeeds; retrieval silently steered** (C3, **V**) | 🔴 | Enable RLS + read-only policy; revoke write grants |
| S8 | Dev console deployed publicly | Unauthenticated LLM endpoint (L1.1) | 🟠 | Auth before any deployment |

---

# Recommended Improvements

Priority = impact ÷ effort, weighted by the project's own stated ordering (quality → speed → cost → reliability → scalability → simplicity → maintainability).

## Immediate (this week) — high value, low effort

| # | Action | Benefit | Complexity | Cost | Priority | Reasoning |
|---|---|---|---|---|---|---|
| I1 | **Enable RLS + read-only policies on the 6 publicly-writable tables; revoke anon write grants** | Stops anonymous modification of `tag_synonyms` (which steers retrieval) and of the directory backup | Low | ~0 | **P0** | Verified live. Agent uses service-role, so zero functional impact |
| I2 | **Remove the `limit 10` from `get_partner_profiles`; warn on short hydration; drop profile-less partners** | Removes the active fabrication vector | Low | ~0 | **P0** | 90% of shortlisted profiles currently arrive empty |
| I3 | **Replace the centroid query with a `city_centroids()` SQL aggregate** | Restores 314 cities and correct distances | Low | ~0 | **P0** | The partner-injection algorithm is the product; it is running on half a map |
| I4 | **Fix the degraded-embedding path** (rank by `rrf_score`, bypass the cosine floor) | Fallback actually degrades instead of failing | Low | ~0 | **P1** | Verified: returns 0 partners today |
| I5 | **Pass `filters.tags` into `match_partners`** | Activates a dead ranking branch; defuses `requireTagMatch` | Trivial | ~0 | **P1** | One line; unblocks tag ranking + synonyms |
| I6 | **Fix the 3 dead-tool references in `instructions.md`** (lines 139, 257, 338) | Removes §11-class ambiguity from a safety rule | Trivial | ~0 | **P1** | Rewrite to `find_partners`; do not delete the rules |
| I7 | **Add `intentText` to the search-cache key** | Stops cross-intent result bleed | Trivial | ↑ latency | **P1** | Correctness over hit-rate |
| I8 | **Derive the disclosure from `chosen`; clamp `finalRecommendations`** | Disclosure can no longer describe unshown partners | Low | ~0 | **P1** | Direct honesty-invariant fix |
| I9 | **Embed once before gap-fill fan-out; add fetch timeouts** | −9 API calls/search; removes a hang path | Low | ↓ cost | **P2** | Pure win |
| I10 | **Fix the 7 stale "Curator was used" assertions** | Makes the local harness trustworthy again | Low | ~0 | **P2** | Prerequisite for Phase 0 |
| I11 | **`CREATE INDEX partners_city_idx ON partners (city)`** | Removes a linear scan before it matters | Trivial | ~0 | **P2** | Cheap insurance |

## Medium-term (2–6 weeks) — architectural

| # | Action | Benefit | Complexity | Cost | Priority | Reasoning |
|---|---|---|---|---|---|---|
| M-1 | **Build the Phase-0 eval suite** (grounding, profile-completeness, disclosure accuracy, rule #10, borrowing, clarification) and migrate to LangSmith | Makes every later change measurable | Medium | Med | **P0** | §11 proves a fabricating agent scores *better* on efficiency metrics. None of C1–C3 were caught by current telemetry |
| M-2 | **Add work-performed metrics** — profiles-hydrated / partners-shown ratio, cities-in-centroid-map, empty-profile count, cache-read share | Would have caught all three critical bugs | Low | Low | **P0** | Pair every efficiency metric with a work metric |
| M-3 | **Rank on `rrf_score`; retune or replace `similarityThreshold` with top-k** | Real quality win, no latency cost | Medium | ~0 | **P1** | The DB already computes the right signal |
| M-4 | **OR the FTS terms** | Restores the keyword branch for German intents | Low | ~0 | **P1** | Verified: 0 matches today on realistic queries |
| M-5 | **Settle the config experiment** — re-measure after I2, then ship a tuned profile | Removes ~41k tokens/search of unread payload | Low | ↓↓ cost | **P1** | Current measurements are invalid until C2 is fixed |
| M-6 | **Shared cache (Redis) + single-flight + bounded embedding cache** | Enables horizontal scaling; fixes a leak | Medium | Low | **P2** | Blocks multi-instance deployment today |
| M-7 | **City disambiguation** — return top-3 from `resolve_city_fuzzy`, ask when close | Fixes "Neustadt" silently resolving | Medium | Low | **P2** | Real UX defect in a 649-city directory |
| M-8 | **Auth on the dev console; injection-hardened profile delimiters** | Closes two exposure surfaces | Medium | Low | **P2** | Required before any deployment |
| M-9 | **Parameterize the `limit 40` CTEs; add the `partner_intelligence` FK** | Makes `k`/`dedupHeadroom` meaningful; removes a round-trip | Low | ~0 | **P3** | Currently silently ignored |

## Long-term (2–6 months) — strategic

| # | Action | Benefit | Complexity | Cost | Priority | Reasoning |
|---|---|---|---|---|---|---|
| L-1 | **Use the data already in the database** — `quality_score` (the eval's recurring complaint), `okf_profiles.opening_hours` (**335 partners, verified**), `courses` (**7,759 rows, verified**) | Directly answers the questions rule #10 must currently decline | Medium | Low | **P1** | Highest-value unexploited asset. Turning "hours not available" into a real answer for 14% of the directory is a visible product win |
| L-2 | **Restructure `match_partners` for HNSW push-down** | Removes the scaling wall | High | ~0 | **P2** | Irrelevant at 2.3k rows, fatal at 10× |
| L-3 | **Explore the `okf` knowledge graph** (`okf_recommendations`, `okf_neighbors`, `nodes`/`edges`/`adjacency`) | A genuinely unexplored retrieval strategy | High | Med | **P3** | Only worth it once M-1 can measure whether it helps |
| L-4 | **Then, and only then, compare architectures** (router, planner/executor, multi-agent) | The repo's stated purpose | High | High | **P3** | Without M-1 these are matters of taste |

---

# Future Architecture Considerations

**Keep the current shape.** The measured problem was too many model hops, not too few. Adding a router, a planner, or re-introducing a curator would reverse the one change that demonstrably worked. The `CLAUDE.md` §13 "explicitly not recommended" list is correct and this review endorses it without qualification.

The improvements that matter are all *beneath* the agent layer:

1. **Push aggregation into the database.** C2 exists because a per-city aggregate was computed in JavaScript over a transferred row set. The `city_centroids()` RPC pattern generalizes: anything that is a `GROUP BY` belongs in Postgres, where there is no row cap and no transfer cost.

2. **Make silent truncation structurally impossible.** Both C1 and C2 are the same defect wearing different clothes: *a query returned fewer rows than requested and nobody noticed*. Introduce a single `assertComplete(requested, received, context)` helper and route every batch/bulk fetch through it. This is a ~20-line change that would have caught two of the three critical findings.

3. **Separate the retrieval layer from the ranking layer.** Today `similarity` is simultaneously a filter, a sort key, and a display value. Splitting these — RRF rank for ordering, top-k for cutoff, cosine for display only — resolves H1, H3 and the `similarityThreshold` retuning problem in one change and makes the retrieval layer independently testable against a fixed query set.

4. **Cache at the right granularity.** One key over the whole search forces a false choice between correctness (H5) and hit rate. Two caches — home-city fetch keyed on canonical city (intent-independent, high hit rate, safe) and gap-fill keyed on city + intent hash (lower hit rate, correct) — gets both.

5. **Re-review the database contract whenever application code depends on it.** C1 and C3 both exist because something written once — a function body, a grant — was never read again while the application evolved around it. A `limit 10` that was harmless when `finalRecommendations` was 5 became a grounding defect when it became 100. Give every `SECURITY DEFINER` function and every non-default grant a named owner and a review date, and assert the contract from the application side rather than assuming it holds.

6. **Build the measurement layer before the architecture bench.** The repo's stated long-term goal — comparing agent architectures on quality, speed, cost, reliability, scalability, simplicity and maintainability — is unreachable while there are 0 datasets, ~8× cost error, and an eval harness asserting a deleted subagent. Phase 0 is not a prerequisite in the bureaucratic sense; it is the difference between comparison and opinion.

---

# Final Recommendations

**The five actions that matter most, in order:**

1. **Stop anonymous writes (I1).** Partner data being publicly readable is intentional and correct. Six tables being publicly *writable* is not — and one of them, `tag_synonyms`, is read by `match_partners` at query time, so the public key is a lever on what the recommendation engine surfaces. Enable RLS with explicit read-only policies and revoke the write grants. Zero functional impact: the agent uses the service-role key.

2. **Remove the `limit 10` (I2).** Ninety percent of shortlisted partners currently reach the model as a name with no profile text, while the prompt instructs the model to describe them specifically. This is the §11 failure mode reconstructed from the data side, and every metric the project monitors reads green while it happens. Then make the pipeline refuse to render a profile-less partner — a missing partner is honest, a blank one is an invitation.

3. **Fix the city map (I3).** The partner-injection algorithm — the thing that makes this product work on a directory whose median city has one partner — is running on 334 of 648 cities and on centroids computed from truncated data. Aggregate in SQL.

4. **Build Phase 0 before touching anything else (M-1, M-2).** All three critical findings were invisible to `app.tools_used`, `app.model_steps`, resolution-event counts and cost telemetry. `CLAUDE.md` §11 already records the lesson — *"the cheapest possible agent is one that hallucinates"* — and this review is that lesson recurring in a new form. Add a profiles-hydrated/partners-shown ratio and a cities-in-map gauge; both are one-line metrics that would have caught C1 and C2 on day one.

5. **Fix retrieval scoring, then re-open the config question (I4, I5, M-3, M-4, M-5).** Use `rrf_score` instead of raw cosine; pass `filters.tags`; OR the full-text terms; make the degraded path actually degrade. These are pure quality wins with no latency cost and no LLM involvement. Only after they land — and after C1 is fixed — is the wide-context config experiment measuring anything real.

**Do not** add agents, orchestration layers, or specialized per-facet tools. Two tools is the right budget. Every problem found in this review is a data-layer problem wearing an AI costume, and none of them would be improved by another model hop.

**One meta-observation.** The root `CLAUDE.md` is a genuinely excellent engineering document, and it independently identified six of the issues confirmed here. The three it missed — C1, C2, C3 — share one property: they are all **boundary defects**, where correct application code meets a database contract nobody re-read. Every one is invisible from the TypeScript side and obvious from the SQL side. That is the seam worth watching.

---

*All quantitative claims in this document were verified against the live Supabase project and the live PostgREST API on 2026-08-01. Reproduction commands and SQL are inlined with each finding.*

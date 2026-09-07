# Navio Partner Agent — Supabase build (R13 port)

The Navio partner-recommendation agent (**"Partner finden"**) with **Supabase/Postgres** as its
directory. It is a 1:1 port of the Convex build in `../partner-recommendation-agent-convex`,
which is Navio's production partner agent and the **reference implementation**: same R13
parallel-search pipeline, same prompt, same config dials, same tools, same Langfuse trace
contract, same feedback system, same dev console. Only the data facade differs.

| | |
|---|---|
| Status | Independent, runnable, verified 2026-09-07 (typecheck, 439/440 unit tests, S1–S6 live, smoke, one real agent turn) |
| Reference | `../partner-recommendation-agent-convex` — change things THERE first, then copy here |
| Retired sibling | `../partner-recommendation-agent` — the pre-R13 Supabase build, untouched, kept for history |
| Data facade | [`lib/supabase.ts`](lib/supabase.ts) — six operations over PostgREST + four RPCs |
| Differences | [`PARITY-NOTES.md`](PARITY-NOTES.md) — everything that is not identical, and why |
| Setup | [`SETUP.md`](SETUP.md) |
| Local port | **3006** (widget 3001, Docker 3002, orchestrator 3003, Convex build 3005) |

## Run it

```powershell
npm install
cp .env.local.example .env.local      # fill in Supabase (service role!), Azure, embeddings, Langfuse
npm run supabase:verify               # S1–S6 against the live project
npm run dev:ui -- -p 3006             # eve dev host + Next dev console
```

To put it behind the Navio widget, set the widget's `PARTNER_AGENT_HOST=http://127.0.0.1:3006`
(never the widget's own port — see root CLAUDE.md §10.6) and restart the widget.

## Commands

| Command | Purpose |
|---|---|
| `npm run typecheck` / `npm test` | must be green before committing (one inherited failure, see PARITY-NOTES §4) |
| `npm run supabase:verify` | live S1–S6: counts, centroid map, hydration, tag branch, vector branch, pgvector decode |
| `npm run smoke` | live credentials + full pipeline for one German request |
| `npm run generate:coverage` | regenerate `agent/instructions/002-city-coverage.md` after a partner import (paged, count-checked) |
| `npm run langfuse:verify <sessionId> -- --expect-search` | read a trace BACK from Langfuse and assert the §16.3b contract |
| `npm run feedback:check` | 👍/👎 score plumbing |
| `npx tsx scripts/live-check.ts "<message>"` with `EVE_HOST=http://127.0.0.1:3006` | one real agent turn over HTTP |
| `npx tsx evals/inspect-output.ts "<message>"` | one eval case end-to-end, no LangSmith write |
| `npx tsx evals/calibrate-evaluators.ts` | grade the graders |

## How a search works (unchanged from the reference)

```
user msg → find_partners({cityMention, intentText, tags})
   resolve_city_fuzzy(place)                        ← RPC
   ├─ partners .in("city", aliases) + intelligence  ← home city, taken WHOLE
   ├─ embed intent once
   ├─ score home relevance (profile_embedding)      ← R13 §4.1, cached 24h
   └─ gap-fill ∥ from nearby cities (city_centroids) via match_partners  ← disclosed
   rank → hydrate top N via get_partner_profiles → render tier 1/2
step 2: model writes the German answer from that result only
```

The model never counts, ranks, dedupes or retrieves. Every named business comes from a
`find_partners` result in that conversation.

## Environment

See `.env.local.example`. The **service-role** key is mandatory: `partners` has RLS enabled with
no policies, so the anon key returns zero rows silently — every city looks empty and nothing
errors. There are no Convex variables in this build.

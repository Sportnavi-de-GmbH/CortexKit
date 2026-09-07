# SETUP — Supabase build

Everything you need to run this build from a fresh clone. No data migration is required: the
agent reads the live Supabase project directly.

## 0. What you need before you start

| | Where it comes from |
|---|---|
| Supabase project URL + **service-role** key | Supabase dashboard → Project Settings → API. The anon key does NOT work (RLS with no policies returns zero rows silently). |
| Azure OpenAI chat deployment | the same deployment the Convex build uses, so both agents phrase alike |
| Embedding endpoint serving `text-embedding-3-small` at 1536 dims | the same endpoint the Convex build uses; the stored `profile_embedding` vectors came from it |
| Langfuse "Navio — Partner" key pair | Langfuse UI → project → Settings → API keys (shared with the Convex build; both are the partner agent) |
| Node 20+, npm | |

The database itself must already carry the schema the retired build used: the `partners`
(with `profile_embedding vector(1536)`, `tags_norm`, `llm_profile`, generated `fts`),
`partner_intelligence` and `tag_synonyms` tables plus the four RPCs `resolve_city_fuzzy`,
`city_centroids`, `match_partners` and `get_partner_profiles`. `npm run supabase:verify`
tells you if anything is missing.

## 1. Install

```powershell
cd SportnaviPartnerRecomandationBot\partner-recommendation-agent-supabase
npm install
```

Own `node_modules`, own lockfile. Nothing is shared with the sibling builds.

## 2. Configure

```powershell
cp .env.local.example .env.local
```

Fill in the blanks marked YOU MUST PROVIDE. This project reads **`.env.local` only** (not
`.env`), loaded by `lib/load-env.ts`, which must stay the first import of every entry point.
Keep `LANGSMITH_PROJECT` different from the Convex build's so traces stay separable;
`Navio Partner-supabase` is the convention.

Never point any script at another build's `.env.local`. The retired build's file is the
historical source of the shared credentials, but nothing here reads or writes it.

## 3. Verify the database

```powershell
npm run supabase:verify
```

Expected (2026-09-07): 2,333 partners / 2,331 active / 2,331 vectors / 2,333 intelligence rows /
89 synonyms / 646 cities, then S2–S6 PASS. Each check names the silent failure it guards against
in its output line.

## 4. Smoke the whole pipeline

```powershell
npm run smoke
```

Runs Supabase → embedding → Azure extraction → `resolvePartners` + `buildRecommendations` for
"Krafttraining rund um die Uhr in Aalen" and prints the rendered tiers.

## 5. Run the agent

```powershell
npm run dev:ui -- -p 3006
```

Then, in another terminal, one real turn over HTTP:

```powershell
$env:EVE_HOST="http://127.0.0.1:3006"; npx tsx scripts/live-check.ts "Yoga in Bochum"
npm run langfuse:verify <session id> -- --expect-search
```

**Never run two dev servers of the same eve project at once** (root CLAUDE.md §16.6.10). Running
this build next to the Convex build is fine — they are different projects — but they share the
Azure TPM quota, so expect 429s if both search at once.

Windows: `src/internal/authored-module-map-loader.ts` is the required eve 0.25.x dev-host shim;
without it `POST /eve/v1/session` fails with `ERR_MODULE_NOT_FOUND`.

## 6. Wire it into the Navio widget (optional)

In `kb-agent-langsmith-starter/.env.local` set `PARTNER_AGENT_HOST=http://127.0.0.1:3006` and
restart the widget. Use `127.0.0.1`, not `localhost`. The widget's proxy is database-agnostic —
switching between this build and the Convex build is only this one variable.

## 7. Deploy to Vercel (when the time comes)

Same recipe as the Convex build (root CLAUDE.md §8): a Vercel project from the `CortexKit` repo
with **Root Directory** `SportnaviPartnerRecomandationBot/partner-recommendation-agent-supabase`,
the §2 variables set, `LANGFUSE_TRACING_ENVIRONMENT=production`, and `PARTNER_PROXY_SECRET`
matching the widget's. The service-role key stays server-side; this build has no public database
functions to harden (unlike the Convex build's R11 blocker).

## 8. After a partner data change

1. `npm run supabase:verify` — counts and branches still healthy.
2. `npm run generate:coverage` — regenerates the top-40 city list baked into the prompt. Do the same
   in the Convex build after it is re-seeded, or the two prompts drift.
3. The in-process caches (search 1 h, centroids 24 h, embeddings 24 h) clear on restart.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Every city "has no partners", no error | anon key instead of service-role key (RLS) |
| `Could not find the function public.<rpc>` | an RPC is missing from the database; run `supabase:verify` to see which |
| `partner N has a K-dim embedding, expected 1536` | mixed embedding space; the stored vectors do not match `EMBEDDING_API_URL`'s model |
| S2 shows ~334 cities | something is reading `partners` unbounded — PostgREST caps at 1,000 rows silently; use the RPC |
| 429 from Azure on every search | size, not frequency: check `maxPartners` / `finalRecommendations` against the TPM ceiling (root CLAUDE.md §10.1) |
| Traces land in "Navio — FAQ" | the widget's `PARTNER_AGENT_HOST` points at itself (root CLAUDE.md §10.6) |

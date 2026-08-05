# AI Agent Monitoring Report — Partner Recommendation Agent

**Project:** `example/partner-recommendation-agent` ("Navio", the Sportnavi partner finder)
**Sentry project:** `ncr4ailab/partner-recommendation-agent` (EU region) — created 2026-07-24
**Report date:** 2026-07-24
**Environment measured:** local development (`npm run dev:ui`), Azure OpenAI `gpt-4.1` (`germanywestcentral`), Supabase partner directory (2,331 active partners), `text-embedding-3-small` embeddings
**Dashboards:** https://ncr4ailab.sentry.io/issues/?project=partner-recommendation-agent · Insights → AI Agents

---

## 1. Executive summary

Until 2026-07-24 this agent had **no error monitoring at all** — only a
PII-safe stdout JSON line per partner resolution. It is now instrumented end
to end with Sentry AI Monitoring: every model call, every tool call, token
usage, and **every class of failure** is captured, verified, and readable by a
non-engineer.

| Check (2026-07-24) | Result |
| --- | --- |
| TypeScript typecheck | **clean** |
| Unit test suite (incl. 11 new Sentry tests) | **165 / 165 pass** |
| End-to-end failure delivery (`scripts/verify-sentry.ts`) | **6 / 6 failure classes VERIFIED** against the live Sentry API |
| Live dependency smoke (`scripts/smoke-live.ts`) | **5 / 5 PASS** (Supabase 2,331 partners · embeddings 1536-dim · Azure LLM · resolve · recommendations) |
| gen_ai span telemetry (model latency, tokens, tool spans) | **confirmed flowing** (`invoke_agent`, `chat gpt-4.1`, `generate_content`, `execute_tool` per tool) |
| Real-traffic load test | executed — see `Performance-Analysis.md` |

**Two significant defects were found during validation:**

1. **eve's native AI telemetry emits no gen_ai spans on this stack** — without
   Sentry's `vercelAIIntegration` forced on, a 30-turn control run (on the
   sibling reference project, same eve/ai/@sentry versions) delivered zero
   model-latency/token spans while everything *looked* healthy. The new
   instrumentation therefore forces the integration ON by default
   (`agent/instrumentation.ts`), with `SENTRY_VERCEL_AI_INTEGRATION=0`
   reserved for re-measurement.
2. **Turns that touch the sandbox can hang indefinitely on Windows dev** — the
   `just-bash` sandbox backend loops on "opening sandbox session" and the turn
   never completes. Detailed in `Bottleneck-Analysis.md` §2.

---

## 2. What is monitored

### 2.1 The agent

Navio turns a request like *"beginner climbing courses in Bochum"* into a
small set of honest partner recommendations from the Supabase directory. Its
workflow per request (see `docs/workflow-walkthrough-nontechnical.md`):

| Step | Component | What happens |
| --- | --- | --- |
| 1a | model (no tools) | coverage check against the in-prompt city list |
| 1b | `extract_city` tool | LLM sub-call extracts city + intent from free text |
| 2–5 | `resolve_partners` tool | home city fetched whole; gap filled from nearby cities via embedding similarity search; deduped, capped |
| 6 | `build_recommendations` + partner-curator subagent | full profiles, re-rank, one "why this one" line per pick |
| 7 | model (no tools) | follow-ups answered from context |

### 2.2 What was added (all of it new on 2026-07-24)

| File | Job |
| --- | --- |
| `agent/instrumentation.ts` | `Sentry.init()` in the **eve agent process** — eve runs separately from Next.js, so no web-layer init can see the agent. Enables AI SDK telemetry + forces `vercelAIIntegration` (see §1 finding 1). Content capture (`SENTRY_RECORD_IO`) **off by default**. |
| `agent/hooks/sentry.ts` | The failure bridge. eve never throws — failures are stream events (`turn.failed`, `step.failed`, failing `action.result`, `session.failed`). This hook captures them with a six-class taxonomy, stable fingerprints, plain-English `failure.label` tags, and the iron rule that a hook must never throw. |
| `lib/sentry-agent.ts` | Pure, unit-tested classify / severity / fingerprint / title / scrub helpers. Integration class matches this project's real dependencies (Supabase, embedding API). |
| `tests/sentry-agent.test.ts` | 11 tests: classification, fatal-on-turn-failure, fingerprint stability, secret scrubbing, and the never-throw guarantee. |
| `scripts/verify-sentry.ts` | Triggers all six classes and **fetches each event back from the Sentry API** — delivery is proven, not assumed. |
| `scripts/load-test.ts` | Baseline + concurrency-ramp driver with per-turn timeouts (a hung turn becomes a data point, not a stuck test). |

### 2.3 Privacy constraints (inherited from `lib/observability.ts`)

No PII, no partner names, no raw user text is ever sent to Sentry: error
messages, tool names, codes, counts, and session ids only. `SENTRY_RECORD_IO`
(prompt/completion capture) is a strict opt-in and stays `false`.

### 2.4 The six failure classes

| Class | Severity | Example in this agent |
| --- | --- | --- |
| `runtime` | error | a tool throws (bug in resolve pipeline) |
| `integration` | error | Supabase or the embedding API unreachable |
| `external` | error | Azure OpenAI 429/5xx |
| `agent` | **fatal** | `turn.failed` / `session.failed` — the user got nothing |
| `performance` | warning | latency budget exceeded |
| `unexpected` | warning | malformed result |

## 3. Validation results (2026-07-24)

`npx tsx --env-file=.env.local scripts/verify-sentry.ts`:

| Failure class | Status | Event ID |
| --- | --- | --- |
| runtime | VERIFIED | `90ff47483c024a25921b55b08c7f81e7` |
| integration | VERIFIED | `0debd4c096d4448cadc6f2b2e4a4ae48` |
| external | VERIFIED | `506d51bf269745209786fe9eed87b1db` |
| agent | VERIFIED | `44c7fa6d4e284a6f89a5d7b1595be1a9` |
| performance | VERIFIED | `5baa496ecb6b4b2bb0ac76a1b58cacc6` |
| unexpected | VERIFIED | `6770dca86b034fe795026b6575e5001f` |

All six now exist as issues in the Sentry project (PARTNER-RECOMMENDATION-AGENT-1…6),
titled in plain English.

Real-traffic telemetry confirmed per turn: `invoke_agent eve-partner-agent`,
`chat gpt-4.1`, `generate_content gpt-4.1`, and `execute_tool` spans for
`extract_city`, `resolve_partners`, `build_recommendations`, plus the
structured resolution JSON lines (unchanged) in the server log.

## 4. Known limits and caveats

- **Web/browser layer not instrumented.** The Next.js UI has no Sentry init;
  the agent process is where all AI work happens and is fully covered.
  Adding `@sentry/nextjs` to the UI is roadmap item P3.
- **Token triple-count.** With `vercelAIIntegration` forced, usage appears on
  three span ops per model call (`chat`/default, `invoke_agent`,
  `generate_content`). Aggregate on ONE op only — all numbers in this package
  do.
- **Dev-machine numbers.** Latency shapes are meaningful; absolute values will
  differ on Vercel.
- **Sandbox hang.** See finding 2 (§1) — affects Windows local dev turns that
  consult the skill; capped by the load-test timeout, root cause documented in
  `Bottleneck-Analysis.md`.

## 5. Operational runbook

| Task | Command |
| --- | --- |
| Prove all six failure classes reach Sentry | `npx tsx --env-file=.env.local scripts/verify-sentry.ts` |
| Live dependency smoke (Supabase / embeddings / Azure) | `npx tsx scripts/smoke-live.ts` |
| Reproduce latency/throughput numbers | `node --env-file=.env.local scripts/load-test.ts` against a running `npm run dev:ui` |
| Re-measure span emission after eve/@sentry upgrades | set `SENTRY_VERCEL_AI_INTEGRATION=0`, `EVE_SENTRY_SPAN_DEBUG=1`, point `EVE_SENTRY_SPAN_LOG` **outside the project** (inside triggers a next-dev recompile loop), drive one turn, count gen_ai lines |
| Unit tests / types | `npm test` · `npm run typecheck` |

Companion documents: `Performance-Analysis.md`, `Cost-Analysis.md`,
`Bottleneck-Analysis.md`, `Optimization-Roadmap.md`; non-technical Excel
package in `reports/excel/`.

# Partner Agent — Cost & Latency Optimization Report

**Date:** 2026-07-31
**Agent:** `partner-recommendation-agent` (eve 0.25.2, AI SDK v7, Azure OpenAI `gpt-4.1`)
**Method:** 6-request representative benchmark replayed against four configurations, with per-event
timings captured from the eve stream and per-call token/cost data from LangSmith EU traces.

---

## 0. Headline

| | Per request | At 200 req/day |
|---|---|---|
| **Believed cost (from LangSmith UI)** | ~$0.20 | ~$1,200/mo |
| **Actual cost, as found** | **$0.0256** | **$153/mo** |
| **Actual cost, after shipped fixes** | **$0.0163** | **$98/mo** |
| **Actual cost, with recommended Phase 2** | **$0.0136** | **$82/mo** |

**Two independent things were wrong, and they pointed in opposite directions:**

1. **Cost was never $0.20.** LangSmith over-reports this pipeline by ~8×. The real figure was
   $0.026. The economics were roughly 8× less alarming than the dashboard suggested.
2. **Latency was genuinely bad and nobody was measuring it.** Requests took **18–60 seconds**.
   That is the real problem with this agent, and it was invisible because the investigation was
   framed around cost.

Shipped changes so far: **−36% cost, −67% latency, −44% tokens.** No loss in retrieval quality.

---

## 1. Why LangSmith said $0.20 and the truth was $0.026

Three separate inflation factors stack multiplicatively:

| Factor | Effect | Detail |
|---|---|---|
| `invoke_agent` double-counting | **×2** | The nested `invoke_agent` llm span reports exactly the same usage as its child `chat` span, and LangSmith's trace rollup sums both. Documented in `EVE_LANGSMITH_TRACING_GUIDE.md` §8.2 and re-confirmed here. |
| Prompt-cache discount ignored | **×~3.4** | **93% of this agent's input tokens are cache reads.** LangSmith prices every input token at the full $2.00/1M rate. Azure bills cached input at $0.50/1M. |
| — | **≈ ×8 combined** | Measured: LangSmith $0.217 vs true $0.026 on comparable turns. |

**The 93% cache-hit rate is the most important economic fact about this agent and it was not on
anyone's dashboard.** The system prompt is large (28,411 chars ≈ 7,300 tokens) but it is *stable*,
so the provider caches it and re-reads cost a quarter of list price. This is why a 51,000-token
request costs 4 cents rather than 10.

> **Verify before trusting this number.** The $0.0256 figure assumes Azure applies the standard 25%
> cached-input rate. `cacheReadTokens` comes back non-zero from the provider, which means caching is
> definitely *active* — but confirm the discount against an actual Azure invoice line before using
> these figures for budgeting. If caching were somehow not discounted, the true cost would be
> $0.076/request ($456/mo at 200/day) — still 2.6× below the assumed $0.20.

**Standing recommendation:** treat LangSmith cost as a *relative* signal for spotting regressions
between requests. It is not a billing figure for this pipeline and never will be while the
double-count exists.

---

## 2. Where the money and time actually went

Baseline measurements, 6 requests:

| Request | Steps | Input tokens | Latency | Tools called |
|---|---|---|---|---|
| "Hallo! Wer bist du?" | 1 | 10,989 | 8.0 s | — |
| "Yoga-Studios in Dortmund" | 4 | 51,376 | 18.1 s | extract_city → resolve_partners → build_recommendations |
| "Fitnessstudio in Berlin" | 4 | 47,466 | 43.4 s | same |
| "Kampfsport in Bergkamen" | 4 | 47,642 | 55.5 s | same |
| "best yoga studio" | 1 | 10,986 | 13.1 s | — (asks for city) |
| "Hamburg" | 4 | 48,797 | 59.7 s | same |

### Root cause 1 — Four model calls to do one search

A partner search ran as four model steps. Steps 1–3 produced **17–82 output tokens each**: they were
pure tool-call dispatch, relaying data between three tools that always run in the same fixed order.
Only step 4 wrote anything a user reads.

Every one of those steps re-sent the entire ~11,000-token prefix (system prompt + tool schemas).
**Roughly 33,000 of the 51,000 input tokens per request existed only to let the model act as a
message bus between three deterministic functions.**

### Root cause 2 — A hidden fifth LLM call inside `extract_city`

`extract_city` called `generateObject` against Azure to parse the city out of the user's message —
**text the main model had already read.** Measured cost of that call: ~180 tokens, but **6.7 s to
14.5 s of latency**. It was invisible in the step counts because it is not an eve turn step; it only
shows up as a `generate_content` span in the OTLP trace.

This was the single worst latency-per-value item in the system: a full model round-trip to extract a
city name that the orchestrating model could have named itself for ~30 output tokens.

### Root cause 3 — 17 tools advertised, 7 of them irrelevant and dangerous

Every model call carried schemas for **17 tools**, including eve's built-in `bash`, `read_file`,
`write_file`, `glob`, `grep`, `todo`, and `agent`. A partner-recommendation agent has no use for
shell access or a workspace filesystem. Cost: **1,469 tokens on every single model call.**

This was also a **security exposure**: `bash` and `write_file` are remote-code-execution surfaces
reachable through user chat text via prompt injection. eve's own documentation flags this —
*"Review these built-in tools before production use. Disable, wrap, restrict, or require approval for
any tool that can access the filesystem, network, shell, or sensitive data."*

### Root cause 4 — Per-turn Docker sandbox provisioning

The dev log shows `opening sandbox session "root" on backend "docker"` **~3× per request**, one
observed instance taking 5 s. The sandbox exists to serve the shell/file tools.

**Important caveat, measured:** disabling those tools did **not** stop the provisioning (17 opens
remained afterwards). eve appears to prepare the sandbox per session regardless of the advertised
tool set. The latency win reported below therefore comes from token reduction, *not* from
eliminating the sandbox. See §5 for the open item.

---

## 3. What was changed and what it delivered

Each stage was measured independently on the identical 6-request set.

| Stage | Steps | Input tokens | Wall clock | Cost/req | $/mo @200/day |
|---|---|---|---|---|---|
| **A** — as found | 18 | 217,256 | 198 s | $0.0256 | $153 |
| **B** — built-ins disabled | 17 | 180,975 | 152 s | $0.0227 | $136 |
| **D** — + `find_partners` ✅ **shipped** | 10 | 108,507 | 65 s | **$0.0163** | **$98** |
| **E** — + legacy tools removed (Phase 2) | 10 | 99,053 | 55 s | $0.0136 | $82 |

Fixed prefix per model call: **10,989 → 8,954 tokens** across A→E.

### ✅ Shipped: disable 7 unused built-in tools

`agent/tools/{bash,read_file,write_file,glob,grep,todo,agent}.ts` each export `disableTool()`.

- **−1,469 tokens on every model call** (−13.4% of the fixed prefix)
- **−23% wall clock**
- Removes the shell/filesystem prompt-injection surface

**Trade-off:** the agent permanently loses shell and filesystem capability. For this agent that is
purely upside — it reads from Supabase and writes prose. Re-enabling is deleting one file.

### ✅ Shipped: `find_partners` — one tool replaces the three-tool chain

New `agent/tools/find_partners.ts` runs `resolveCityFuzzy` → `resolvePartners` →
`buildRecommendations` server-side in a single call. The main model supplies `cityMention`,
`intentText` and `tags` directly from the message it has already read.

- **4 model steps → 2** on every partner search
- **Eliminates the hidden `generateObject` call** (−6.7 to −14.5 s)
- **−56% input tokens** on search requests (51,376 → 23,722 on R2)
- **Latency: 18.1 s → 9.1 s, 43.4 s → 11.2 s, 55.5 s → 7.3 s, 59.7 s → 26.8 s**

**Retrieval quality is unchanged** — verified by comparing resolution events. Bergkamen still
returns 6 home partners plus 4 borrowed from Kamen and Werne, identical to baseline.

**Trade-offs, stated honestly:**

1. **The model can no longer improvise a different tool order.** In practice it never did — all
   three baseline searches used the identical fixed sequence — but genuinely novel situations now
   have one less escape hatch.
2. **City extraction moved from a dedicated structured-output call to the main model's tool
   arguments.** Quality looked equal or better across the benchmark (including the misspelling and
   city-only cases), but this is the change most deserving of a proper eval set.
3. **Final answers got shorter** (e.g. R2: 2,021 → 1,255 chars). Content remained accurate and
   grounded. Whether shorter is better is a product call — flagging it rather than claiming it as a
   win.

---

## 4. ⚠️ The failure this investigation nearly shipped

**First attempt at `find_partners` produced spectacular-looking numbers: $0.0106/request, 32 s total,
−58% cost. It was completely wrong.** The agent had stopped doing its job.

Only **1 database search ran across 6 requests**. For "Yoga-Studios in Dortmund" the model returned
five confidently-described studios — *YogaYa, Yogastudio am Phoenixsee, Soul Yoga Dortmund* — with
invented details attributed to "laut Profil" ("according to the profile"). **It had never queried the
database.** It was cheap and fast because it was fabricating.

**Cause:** my instruction rewrite. I replaced three bare imperatives (`Call extract_city`) with a
softer heading plus a paragraph beginning *"Do not chain tools to do this."* The model appears to
have generalised that into "do not call tools." The pre-existing `Never invent partners` rule sits
~130 lines away in a different section and did not save it.

**Fix:** an explicit grounding mandate at the point of instruction —

> You have **no** partner data of your own. You have never heard of any partner that this tool did
> not return to you in this conversation. […] If you are about to name a business you did not read
> out of a tool result, stop and call the tool instead.

After the fix: 4 DB searches for 4 city requests, 0 for the 2 non-search requests. Correct.

**Three lessons, all of which generalise beyond this agent:**

- **A cost optimization that reduces work is indistinguishable from a cost optimization that skips
  work, if you only look at cost.** Token and latency graphs both improved *more* in the broken
  version than the correct one. Never accept an efficiency win without a grounding assertion.
- **The cheapest possible agent is one that hallucinates.** Any cost metric must be paired with a
  work-actually-performed metric. Here the honest one was free and already in the log: the count of
  `requestedCity` resolution events. That single number is the difference between a −58% win and a
  reputational incident.
- **Negative instructions leak.** "Do not chain tools" was intended narrowly and read broadly.
  Prefer stating what the model *must* do over what it must not.

---

## 5. Recommended next steps

### Phase 2 — Remove the six now-redundant tools (measured: −$16/mo, −10 s/6 requests)

`extract_city`, `resolve_partners`, `build_recommendations`, `find_nearby_cities`,
`get_partners_by_city`, `similarity_search_partners` are now all internal to `find_partners`. Removing
them was measured (stage E): fixed prefix 9,899 → 8,954 tokens, cost $0.0163 → $0.0136.

**Not shipped** because it requires a documentation migration first — `agent/instructions.md` (lines
119, 239, 320), `agent/skills/partner-injection/SKILL.md` (essentially the whole file describes the
old three-call sequence), and `agent/subagents/partner-curator/instructions.md` all still reference
them. Removing the tools while leaving those references is an incoherent state. Budget this as a
docs task with a quality pass, not a code deletion.

### Investigate the per-turn Docker sandbox (unquantified, possibly seconds/request)

Disabling the sandbox-backed tools did not stop provisioning. Worth one focused experiment against
eve's `sandbox` configuration to see whether it can be switched off entirely for an agent that never
touches it. One observed open took 5 s.

### Fix or delete the `partner-curator` mandate

`agent/instructions.md` states the shortlist must be delegated to the `partner-curator` subagent
**"exactly once"** before answering. **Traces show it is never called** — not once across any
configuration. So either:

- the instruction is dead and should be deleted (it costs prompt tokens and misleads readers), or
- it is a real requirement being silently skipped, in which case recommendations are currently
  ranked on tags alone, which is a **quality** bug that predates this work.

This needs a product decision. Note that actually honouring it would *add* a subagent turn and
meaningfully increase cost — worth knowing before enabling it.

### Build an eval set before tuning further

Every remaining optimization trades against answer quality, and 6 requests cannot measure that.
The §4 near-miss is the argument: a fabricating agent scored *better* on every efficiency metric.
The eval needs at minimum: a grounding check (every named partner appears in the tool result), the
borrowed-city disclosure, and the clarifying-question path. `tests/agent-test/dataset.json` already
exists as a starting point.

### Consider a cheaper model for the final composition step

Not attempted. Now that the pipeline is 2 steps, step 1 is trivial tool dispatch and could plausibly
run on a much cheaper model, with `gpt-4.1` reserved for the user-facing prose in step 2. Worth
testing once an eval set exists — but this genuinely risks quality and should not be done blind.

---

## 6. What to monitor from here

| Metric | Where | Alarm |
|---|---|---|
| `app.tools_used` empty on a city request | LangSmith summary run metadata | **Fabrication.** The §4 failure mode. |
| Resolution events per request | agent log `requestedCity` count | Should equal the number of city requests |
| `app.model_steps` | LangSmith summary run | Should be **2** for a search, **1** for greeting/clarification. A 4 means the old chain came back |
| `app.tokens.input` | LangSmith summary run | ~22k/search post-fix. A jump means the prefix grew |
| Cache-read share | `step.completed.data.usage.cacheReadTokens` | Was 93%. A drop means prompt instability and a ~4× cost rise |

That last row deserves emphasis: **prompt-cache hit rate is the single highest-leverage cost metric
for this agent**, worth more than any token trimming. Anything that makes the system prompt vary
per-request — injecting timestamps, user names, or rotating content into the prefix — would quietly
multiply the bill by up to four. It is currently unmonitored.

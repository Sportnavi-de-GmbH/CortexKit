# Production-Readiness Review — Navio (cost, latency, reliability, security)

> **Scope:** the `kb-agent-langsmith-starter` agent (**Navio**) as it exists on branch
> `feat/observability-cost-audit`. Grounded in the actual source, not generic advice.
> **Target stack:** eve `0.25.3` on the Vercel AI SDK (`ai@7`), Azure OpenAI `gpt-4.1`
> behind (optionally) the Vercel AI Gateway.
> **Author's note on figures:** token/cost numbers are estimates from the code and public
> list prices (verify against your Azure/Gateway contract). Where a repo doc and the code
> disagree, this report trusts the code.

---

## 0. Read this first — the one reframe that governs everything

**Navio is a no-tool, single-call agent by design.** [`agent/agent.ts`](../agent/agent.ts)
defines an agent with **zero tools, zero subagents, zero skills**; all 11 eve built-ins are
disabled via `disableTool()` sentinels in [`agent/tools/`](../agent/tools/). There is **no
agentic reasoning loop** — one user turn = **one model call** with a static system prompt
passed as `instructions`.

That single fact rewrites your priority list:

| Your request | Applies to Navio? | Why |
|---|---|---|
| P1.1 Cap reasoning steps / tool calls | **N/A (already 0)** | No tools ⇒ no multi-step loop. eve makes one model call per turn. |
| P1.2 Reduce/disable retries | **Partially** | No agent-loop retries; only AI SDK's internal call retries + an eval-only `withRetry`. |
| P1.3 Dedupe duplicate tool calls | **N/A for the agent** | No tools. *Reframed* onto the contact form (double-submit) below. |
| P2.4 Improve tool descriptions | **N/A** | No tools to describe. |
| P2.5 Shrink tool responses | **N/A** | No tools. *Reframed* onto Salesforce/observability payloads. |
| P2.6 Execution budgets | **HIGH — mostly missing** | eve exposes session token limits; they are **unset** (defaults). |
| P3.7 Cache expensive tool/API results | **Partial** | No tools; but **prompt caching** and Salesforce token caching apply. |

**Where the money and latency actually are:** a **~16.7k-token static system prompt
replayed on every single turn**, on a **public, anonymous** endpoint with **no per-session
token cap set** and **no hard per-request cost ceiling unless the AI Gateway is enabled**.
80% of the wins below live in three moves: **(1) guarantee prompt caching is active,
(2) deploy the shorter prompt, (3) set `limits` + a Gateway spend cap.**

> ⚠️ **Documentation correction:** `CLAUDE.md` states the prompt is "~41.5k tokens." Your
> own [`scripts/cache-check.ts`](../scripts/cache-check.ts) measures it at **~16.7k tokens**
> (70 KB / 1,384 lines / ~9.6k words). This report uses **16.7k**. Fix the stale figure.

---

## 1. Scorecard

| Dimension | State | Grade |
|---|---|---|
| Reasoning-loop / tool-call bounds | No tools; nothing to bound | ✅ N/A |
| Retry behavior (production path) | AI SDK defaults; eval path fails-fast on 4xx (good) | 🟡 OK |
| Per-session / per-request budgets | `limits` **unset** → 40M input tokens/session default, output uncapped | 🔴 Gap |
| Per-request hard cost ceiling | Only if `AI_GATEWAY_MODEL` set; unset ⇒ direct Azure, no cap | 🔴 Gap |
| Prompt size / caching | 16.7k prompt every turn; caching *possible* but unverified in prod | 🟠 High-value |
| Input guardrails | Origin + BotID + edge RL; **chat message length uncapped** | 🟠 Gap |
| Prompt-injection protection | In-prompt HARD LIMITS only (soft control) | 🟡 Partial |
| Output guardrails | None automated (prompt asks for <400 words, unenforced) | 🟡 Partial |
| Tool security / authz | No tools; contact form is server-only, creds never client-side | ✅ Good |
| Sensitive-data handling | LangSmith IO off by default ✅; **contact PII logged to console** 🔴 | 🟠 Mixed |
| Error handling / fallback | Hooks never throw ✅; contact has no email fallback | 🟡 Partial |
| Observability / tracing | Strong (LangSmith EU, cost dedup, per-visitor attribution) | ✅ Strong |
| Rate limiting / abuse | Edge + BotID good; **contact limiter is per-instance (ineffective)** | 🟠 Gap |
| Secrets hygiene | **Real keys committed in `.mcp.json`** | 🔴 Gap |

---

## PRIORITY 1 — Highest impact

### P1.1 — Cap reasoning steps & tool calls — *N/A, verify it stays that way*

- **Problem:** Runaway tool/step loops inflate cost and latency. Navio has **no tools**, so
  there is no loop to cap.
- **Why it matters:** A future contributor could add a tool and inadvertently enable eve's
  multi-step loop. The invariant ("no tools") is worth *guarding*, not just assuming.
- **Impact:** **Low** (preventive).
- **Recommendation:** Keep the 11 `disableTool()` sentinels; assert the invariant in a test
  so a regression fails CI. You already have [`tests/agent.test.ts`](../tests/agent.test.ts) —
  ensure it asserts tool count is 0.
- **Example (guard test):**
  ```ts
  // tests/agent.test.ts — lock the no-tool invariant
  import agent from "../agent/agent";
  it("ships zero tools (no agentic loop, one call per turn)", () => {
    expect((agent as { tools?: unknown[] }).tools ?? []).toHaveLength(0);
  });
  ```
- **Estimated savings:** none directly; prevents accidental N× cost regressions.

### P1.2 — Reduce/disable automatic retries

- **Problem:** Two retry mechanisms exist. (a) The AI SDK retries failed model calls
  internally (default **2 retries**). (b) [`lib/eval/rate-limit.ts`](../lib/eval/rate-limit.ts)
  `withRetry` does **up to 6 attempts** — but this is **eval-only** and correctly **never
  retries deterministic 4xx** (`content_filter`, etc.).
- **Why it increases cost/latency/risk:** Retrying a *deterministic* failure (content policy
  block, malformed request) re-sends the full ~16.7k-token prompt and pays for it again with
  zero chance of success — pure waste, and on a public endpoint an attacker can weaponize it
  (each blocked jailbreak billed 3×). Retry storms also amplify a provider outage into a cost
  spike.
- **Impact:** **Medium** (High during incidents).
- **Recommendation:**
  1. **Keep the eval `withRetry` out of the request path** (it already is — confirm no import
     from `app/` or `agent/`).
  2. Port its **fail-fast-on-4xx** discipline to production. eve drives the AI SDK call, so you
     cannot pass `maxRetries` from `defineAgent`; instead **rely on the Gateway/AI-SDK default
     (2)** and ensure content-filter 4xx are surfaced, not retried. Verify with a forced
     `content_filter` input that you see **one** billed call, not three.
- **Example (fail-fast predicate, already in your repo — reuse for any custom wrapper):**
  ```ts
  // lib/eval/rate-limit.ts — the pattern to preserve everywhere
  if (status >= 400 && status < 500) return false;        // never retry 4xx
  if (msg.includes("content_filter")) return false;        // deterministic → fail fast
  ```
- **Estimated savings:** eliminates **2× extra billed calls** on every deterministic failure
  (~$0.076/blocked-turn saved at current prompt size); prevents runaway spend during outages.

### P1.3 — Detect & prevent duplicate calls with identical arguments

- **Problem (reframed):** No tools to dedupe. The real duplicate-work risks are: **(a)
  double-submitted contact forms** ([`app/api/contact/route.ts`](../app/api/contact/route.ts)
  creates a Salesforce Case with no idempotency key), and **(b)** repeated identical chat
  questions within a session paying full price each time.
- **Why it increases cost/risk:** A double-click or retry creates **duplicate Salesforce
  Cases** (dirty CRM data, duplicate notifications). Identical repeated LLM turns re-bill the
  full prompt.
- **Impact:** **Medium**.
- **Recommendation:**
  - **Contact:** require a client-generated idempotency key; skip the Salesforce call if the
    same key was seen recently (Vercel KV or Edge Config, since serverless memory is
    per-instance — see P-RateLimit).
  - **Chat:** duplicate-question caching is covered by prompt caching (P3.7) — the marginal
    cost of a repeat question is already just the cached-prefix price; a full response cache is
    **not recommended** (answers are personalized/contextual and low-value to cache).
- **Example (idempotent contact submit):**
  ```ts
  const key = req.headers.get("idempotency-key");
  if (key && (await kv.get(`contact:${key}`))) return json({ status: "ok", deduped: true }, 200);
  const { ok } = await submitCase(inputs);
  if (ok && key) await kv.set(`contact:${key}`, "1", { ex: 600 }); // 10-min window
  ```
- **Estimated savings:** removes duplicate CRM Cases; avoids duplicate Salesforce API calls.

---

## PRIORITY 2 — High impact

### P2.4 — Improve tool descriptions — *N/A*

No tools. The equivalent lever for a prompt-only agent is **prompt clarity** (P3.9): the
"BEHAVIOR RULES" and "HARD LIMITS" sections are Navio's "when to act" contract. Keep them
crisp; every ambiguous rule costs tokens on every turn.

### P2.5 — Reduce tool/response payload size — *reframed onto payloads you do send*

- **Problem:** No tool responses, but two payloads are larger than they need to be:
  - **LangSmith export**: with `LANGSMITH_TRACE_COMPLETENESS` unset you export the *full* eve
    execution graph (workflow nodes + steps + network), not just AI spans.
    ([`agent/instrumentation.ts`](../agent/instrumentation.ts) `TRACE_COMPLETE`).
  - **Salesforce error text**: `submitCase` slices error bodies to 500 chars (good) but logs
    the full `inputs` (PII) on failure.
- **Why it matters:** Full-graph export increases LangSmith ingest volume and noise (cost +
  slower trace reads); PII in logs is a data-handling risk (see Sensitive Data).
- **Impact:** **Low–Medium**.
- **Recommendation:** For high-traffic production, set `LANGSMITH_TRACE_COMPLETENESS=ai` to
  export only AI spans + ancestors; keep full-graph for staging/debugging. Redact PII before
  logging (below).
- **Estimated savings:** materially fewer exported spans per turn ⇒ lower LangSmith usage and
  faster trace loads.

### P2.6 — Execution budgets — **the biggest reliability/cost gap** 🔴

- **Problem:** [`agent/agent.ts`](../agent/agent.ts) sets **no `limits`**, so eve applies
  defaults: **`maxInputTokensPerSession` = 40,000,000** and **`maxOutputTokensPerSession` =
  uncapped**. There is **no per-request cost ceiling** in the agent — the only hard cost cap
  is the **Vercel AI Gateway spend cap, which is inactive unless `AI_GATEWAY_MODEL` is set**
  (when unset, `resolveModel()` calls Azure directly — no cap).
- **Why it increases cost/risk:** This is a **public, anonymous** endpoint. A single abusive
  session could, in principle, drive **40M input tokens ≈ $80 of input at gpt-4.1 list price**
  before eve blocks it, and unbounded output means a jailbreak that coaxes a long generation
  bills freely. No per-request ceiling means one crafted request can be arbitrarily expensive.
- **Impact:** **High.**
- **Recommendation — layer four budgets:**
  1. **Per-session token caps (eve `limits`)** — tight, since support sessions are short:
  2. **Per-request output cap** — Navio should never emit more than a few hundred words.
  3. **Per-request/rolling spend cap** — via the **AI Gateway** (set `AI_GATEWAY_MODEL`, BYOK
     Azure behind it) so the hard spend ceiling and per-visitor attribution activate.
  4. **Wall-clock timeout** — cap the streaming route so a stalled provider can't hold a
     function open (and bill) indefinitely.
- **Example (eve session budgets — the one-line highest-ROI change):**
  ```ts
  // agent/agent.ts
  export default defineAgent({
    description: "Knowledge Base & FAQ agent…",
    modelContextWindowTokens: 1_047_576,
    model: resolveModel(),
    limits: {
      // A support session is a handful of short turns. 40M default → ~250k is generous.
      maxInputTokensPerSession: 250_000,   // ~15 turns of the full prompt; blocks abuse
      maxOutputTokensPerSession: 20_000,   // hard ceiling on generated tokens per session
    },
  });
  ```
- **Example (route-level wall-clock + the Gateway toggle):**
  ```ts
  // The streaming route: bound execution time (Next.js/Vercel)
  export const maxDuration = 30; // seconds — a KB answer never needs more

  // Activate the hard spend cap + per-visitor cost attribution:
  //   set AI_GATEWAY_MODEL (e.g. "openai/gpt-4.1"), BYOK Azure-EU behind the Gateway.
  //   resolveModel() already routes to the Gateway when this env is present.
  ```
- **Estimated savings:** converts an **unbounded** worst-case per session into a **bounded**
  one (250k tokens ≈ **$0.50 hard ceiling/session** vs. **$80** today); the Gateway cap turns
  "unlimited public spend" into a fixed monthly ceiling. This is the single most important
  production-readiness fix.

---

## PRIORITY 3 — Optimization

### P3.7 — Cache expensive results — **prompt caching is the prize** 🟠

- **Problem:** The same **16.7k-token system prompt is re-sent and re-priced on every turn.**
  Azure OpenAI supports **automatic prompt caching** for `gpt-4.1` when the prefix is ≥1024
  tokens and **byte-identical** across requests — your [`scripts/cache-check.ts`](../scripts/cache-check.ts)
  exists precisely to verify this. But nothing guarantees the prod path keeps the prefix
  stable, and cache hits are not currently monitored.
- **Why it matters:** Cached input tokens are billed at a **large discount** (~4× cheaper than
  fresh input on gpt-4.1) and **cached prefill is dramatically faster**, cutting **TTFT**. At
  ~16.7k tokens/turn this is the dominant recurring cost and latency line.
- **Impact:** **High** (recurring, every turn).
- **Recommendation:**
  1. **Guarantee a stable prefix.** Anything that varies per request (timestamps, visitor id,
     dynamic context) must go **after** the static prompt or into runtime metadata, never
     spliced into the prompt prefix. Confirm eve passes `instructions` verbatim (it does).
  2. **Verify in production**, not just via the script: assert `cachedInputTokens` > 0 on
     warm turns. Your metrics layer ([`lib/eval/metrics.ts`](../lib/eval/metrics.ts)) already
     surfaces cache tokens — add a prod alert if the cache-hit ratio drops.
  3. **Salesforce token cache** is already correct ([`lib/contact/salesforce.ts`](../lib/contact/salesforce.ts)
     caches the OAuth token with in-flight collapsing) — no change.
- **Example (make the prefix-stability contract explicit):**
  ```ts
  // Prompt caching only fires on a byte-identical prefix. NEVER prepend/interpolate
  // per-request data into `instructions`. Put dynamic values in runtimeContext/metadata:
  return { runtimeContext: { "app.visitor.id": visitorId } }; // ✅ not in the prompt text
  ```
- **Estimated savings (per turn, gpt-4.1 list ~$2/$8 per 1M in/out, cached-in ~$0.50/1M):**
  - **Uncached:** ~17k in → **$0.034** + output ~$0.004 ≈ **$0.038/turn**.
  - **Cached prefix:** 16.7k @ cached + ~300 fresh + output ≈ **$0.013/turn** → **~55–65%
    cost cut** and a **meaningful TTFT reduction** (cached prefill).

### P3.8 — Reduce prompt/context size; prefer runtime context over prompt context

- **Problem:** The full 16.7k-token prompt (persona + **five embedded KB documents** + rules)
  is sent on **every** turn regardless of the question. Multi-turn sessions also replay
  history. There is **no `limits.maxInputTokensPerSession`** and compaction uses the default
  (0.9 of a 1M window ⇒ effectively **never triggers** for short chats — fine, but it means
  history grows unbounded within a session up to the cap).
- **Why it increases cost/latency:** Every token in the prompt is paid on every turn and adds
  prefill latency. Much of the KB is irrelevant to any single question (a member asking about
  check-in pays for the entire partner-payout and employer-tax sections too).
- **Impact:** **High** (structural), but **higher-effort** than caching.
- **Recommendation (in ascending effort):**
  1. **Deploy the shorter prompt.** `agent/feedback/SYSTEM_PROMPT_V3.md` (646 lines vs 1,384)
     and the `system_prompt_optimization/` v1–v4 candidates roughly **halve** prompt tokens.
     This is the fastest structural win — swap `agent/instructions.md`, then re-run evals
     (`npm run eval:run`) to confirm no quality regression before shipping.
  2. **Move truly static, rarely-relevant KB out of the prompt** only if evals show headroom —
     but note this reintroduces retrieval (RAG), which the project deliberately avoids. **Do
     not add RAG for cost reasons alone**; caching + a shorter prompt capture most of the
     benefit without the architectural change.
  3. **Cap session history** via `limits.maxInputTokensPerSession` (P2.6) so long sessions
     can't silently grow the per-turn input.
- **Example (deploy V3 + gate on evals):**
  ```bash
  cp agent/feedback/SYSTEM_PROMPT_V3.md agent/instructions.md
  npm run eval:run   # compare judge scores vs baseline BEFORE shipping
  ```
- **Estimated savings:** shorter prompt ≈ **~8–9k tokens/turn** → roughly **halves the
  uncached input cost** and stacks with caching. Combined **caching + V3**: **~$0.010/turn**
  vs **$0.038** today (**~70% reduction**) and lower TTFT.

### P3.9 — Simplify prompts / cut tokens without hurting quality

- **Problem:** The prompt carries known redundancy (the `system_prompt_optimization/` notes
  cite v1 = deduplication, v2 = contradiction fix, v4 = output brevity), and stores **two
  copies of the KB** (`agent/instructions.md` and `agent/kb/kb.md`) — only the former is live.
- **Why it matters:** Redundant/contradictory instructions waste tokens every turn and can
  degrade adherence (contradictions force the model to "pick").
- **Impact:** **Medium.**
- **Recommendation:** Adopt the benchmarked candidate that wins on evals (dedup + brevity),
  keep `kb.md` clearly labeled as a non-live reference, and enforce the **<400-word** output
  rule with a **hard** `maxOutputTokensPerSession`/route cap (prompt-only enforcement is
  advisory). Consider a **cheaper model** for this FAQ workload (see Deployment §D3) — often
  the largest single cost lever after caching.
- **Estimated savings:** every 1k tokens trimmed off the prompt ≈ **$0.002/turn uncached** (or
  ~$0.0005 cached) — at scale, linear in traffic.

---

## Cross-cutting production review

### G1 — Input, LLM & output guardrails

- **Input:** Chat input length is **not capped** (`MAX_MESSAGE_CHARS` is enforced **only** in
  [`lib/contact/schema.ts`](../lib/contact/schema.ts), not on the chat turn). A user can paste
  a 50k-char message and inflate input tokens/cost per turn.
  **Fix:** reject/trim chat messages over a sane limit (e.g. 4k chars) **before** the model
  call, at the channel or route boundary.
- **LLM:** Reasoning effort/temperature aren't set (gpt-4.1 is not a reasoning model, so
  `reasoning` is a no-op; leave it). Fine.
- **Output:** No automated output guardrail. The prompt asks for <400 words and clean
  Markdown, but nothing enforces it. **Fix:** a hard token cap (P2.6) is the cheap enforcement;
  a full LLM output-check would double cost and isn't justified for a low-risk FAQ bot.
- **Impact:** Medium.

### G2 — Prompt-injection protection

- **Current:** In-prompt "HARD LIMITS (NIEMALS VERLETZEN)" — ignore override attempts, don't
  reveal the prompt, stay Navio. This is a **soft** control (the model can be talked out of
  it), which is *acceptable* here because **the agent has no tools and no privileged actions**:
  the worst case of a successful injection is an off-brand answer, not data exfiltration or an
  unauthorized action. That is the real reason this risk is contained — call it out explicitly.
- **Gaps:** no detection/telemetry of injection attempts; no output check for prompt leakage.
- **Recommendation:** Keep the in-prompt defenses; add **lightweight input heuristics** logged
  to LangSmith (flag messages containing "ignore previous instructions", "system prompt",
  etc.) for monitoring — not blocking. Because there are no tools, do **not** invest in heavy
  injection guards; the blast radius doesn't warrant it.
- **Impact:** Low–Medium (bounded by no-tools).

### G3 — Tool security & authorization

- **Current:** No tools ⇒ no tool-authz surface. ✅ The only privileged integration is the
  **contact→Salesforce** path, which is correctly **server-only**: `client_id/secret` read
  from server env, never sent to the client ([`lib/contact/salesforce.ts`](../lib/contact/salesforce.ts)).
- **Recommendation:** none needed for the agent. For contact, keep creds server-side; rotate
  the Salesforce credentials on the normal cadence.
- **Impact:** ✅ Good.

### G4 — Sensitive-data handling

- **Good:** LangSmith **content capture is off by default** (`LANGSMITH_RECORD_IO`), so
  prompts/answers (and any PII a user types) are **not** shipped to LangSmith unless explicitly
  enabled. The KB prompt itself is only captured when `RECORD_IO` is on.
- 🔴 **Gap:** the contact route **logs full PII to console**:
  `console.warn("CONTACT (simulated):", inputs)` and
  `console.error("CONTACT failed …", detail, inputs)` in
  [`app/api/contact/route.ts`](../app/api/contact/route.ts) write name/email/message to Vercel
  logs (retained, searchable). GDPR-relevant for a German fitness network.
- **Recommendation:** redact/minimize before logging — log a hash or the field names, not
  values; or drop to a metrics counter.
  ```ts
  console.error("CONTACT failed", { detail, fields: Object.keys(inputs) }); // no PII values
  ```
- **Impact:** Medium (compliance).

### G5 — Error handling & fallback

- **Good:** eve failures are **stream events, never exceptions**; hooks are guarded so they
  **never throw** ([`agent/hooks/langsmith.ts`](../agent/hooks/langsmith.ts)). Salesforce path
  has timeouts (`AbortController`), 401-refresh-retry-once, and a simulate mode.
- **Gaps:** (1) The contact route has **no email/SMTP fallback** — on Salesforce failure it
  returns 502 and relies on **console logs** as the only record (explicitly flagged in the
  code). A dropped log = a lost lead. (2) No documented **user-facing fallback message** for a
  model/stream failure in the chat widget.
- **Recommendation:** wire the noted SMTP fallback (nodemailer + `SMTP_*`) so contact leads
  survive a Salesforce outage; add a friendly chat fallback ("Ich kann gerade nicht
  antworten — bitte versuch es gleich nochmal") on stream-failure events.
- **Impact:** Medium.

### G6 — Monitoring, tracing & observability — ✅ strongest area

- **Current:** LangSmith EU tracing with **one trace per request** (deterministic OTLP
  span-id→run-id anchors), **usage de-duplication** so cost is priced once (`DEDUPE_USAGE`),
  human-readable span names, per-turn summary runs, failure "story" runs, and **per-visitor
  cost attribution** (`snv_vid`). No-op without a key. This is genuinely production-grade.
- **Gaps:** no **alerting** (error-rate, cache-hit-ratio, p95 latency, spend) and no dashboard
  SLOs called out.
- **Recommendation:** add alerts on: model error rate, **cache-hit ratio drop** (regression
  detector for P3.7), p95 TTFT, and daily spend. Surface the AI Gateway spend metric.
- **Impact:** Low (polish on a strong base).

### G7 — Rate limiting & abuse prevention

- **Current:** Chat is protected at the edge by **BotID** (session-create) + origin allowlist
  ([`agent/channels/eve.ts`](../agent/channels/eve.ts)) with the real ceiling meant to be a
  **Vercel Firewall** rule + the Gateway spend cap.
- 🔴 **Gap:** the **contact route's rate limiter is per-instance in-memory**
  (`const hits = new Map(...)` in [`app/api/contact/route.ts`](../app/api/contact/route.ts)) —
  on Vercel's serverless/edge fleet each instance has its own map, so the effective limit is
  `N_instances × 15/min`. The code comments admit it's a "soft guard." The chat's BotID gate
  only runs on **session-create**, not per message — a single accepted session can stream many
  turns.
- **Recommendation:** move rate limiting to **Vercel Firewall rules** (distributed, at the
  edge) for **both** `/eve/v1/*` and `/api/contact`, or a shared store (Vercel KV/Upstash) if
  you must do it in code. Add a **per-session turn cap** (complements P2.6 token caps).
- **Impact:** High (abuse ⇒ direct spend on a public endpoint).

### G8 — Production readiness & deployment

- **D1 — Secrets in git** 🔴: real-looking **LangSmith and Stitch API keys are committed in
  `.mcp.json`**. Rotate both, move to env, and scrub history. Non-negotiable pre-deploy.
- **D2 — Activate the Gateway** (P2.6): set `AI_GATEWAY_MODEL` so the hard spend cap and
  per-visitor attribution are live; keep Azure-EU BYOK behind it for the EU data path.
- **D3 — Model right-sizing** (cost lever): gpt-4.1 for a bounded FAQ bot is likely
  over-provisioned. Evaluate **gpt-4.1-mini** (≈ **5× cheaper** input/output) on your eval set;
  eve's dynamic model API can even route hard questions to the big model and the rest to mini.
  If mini holds judge scores, this is a **~80% per-turn cost cut** on top of caching.
- **D4 — Verify caching in prod** (P3.7): assert `cachedInputTokens>0` on warm traffic.
- **D5 — Env matrix**: confirm all prod envs set — `AZURE_*`, `AI_GATEWAY_MODEL`,
  `WIDGET_ALLOWED_ORIGINS`/`WIDGET_FRAME_ANCESTORS`, `BOTID_ENABLED=true`, `LANGSMITH_*` (EU),
  `SALESFORCE_*`, `CONTACT_RATE_LIMIT_PER_MIN`, `CONTACT_FALLBACK_EMAIL`. `LANGSMITH_RECORD_IO`
  **off** in prod unless a DPA covers it.
- **D6 — `frame-ancestors`/CSP**: confirm `vercel.json` restricts who can embed the widget
  iframe (referenced by the channel comments) — required so the same-origin trust model holds.

---

## Estimated savings summary (per turn, order-of-magnitude, gpt-4.1 list prices)

| Change | Effort | Cost/turn | Δ vs baseline | Also improves |
|---|---|---|---|---|
| **Baseline** (16.7k prompt, uncached) | — | ~$0.038 | — | — |
| **Verify prompt caching active** (P3.7) | Low | ~$0.013 | **−55–65%** | TTFT ↓↓ |
| **+ Deploy V3 shorter prompt** (P3.8/9) | Low | ~$0.010 | **−70%** | TTFT ↓ |
| **+ Switch to gpt-4.1-mini** (D3, if evals pass) | Med | ~$0.004 | **−85–90%** | latency ↓ |
| **Set `limits` + Gateway cap** (P2.6) | Low | (caps worst-case) | 40M→250k / turn: **$80→$0.50 max per session** | reliability ↑↑ |

> Caching and prompt-shortening **stack**. The `limits`/Gateway caps don't lower the *average*
> turn cost — they cap the *worst case*, which on a public anonymous endpoint is the number
> that actually threatens the budget.

---

## Prioritized production-readiness checklist (highest → lowest impact)

> **Status legend:** ✅ done in code (this branch) · ⏳ needs dashboard/ops action or a
> decision · 🕓 deferred by request (prompt/model changes).

**🔴 Blockers — resolve before deploy**

- [x] ✅ **Removed the committed LangSmith key from `.mcp.json`** → `${LANGSMITH_API_KEY}` env
      expansion. ⏳ **You must still (a) ROTATE that key** — it's in git history, so replacing
      the file does not un-expose it — **and (b) set `LANGSMITH_API_KEY` in your shell env** or
      the LangSmith MCP server won't start. *(D1 — security)*
- [x] ✅ **Set `limits` in `agent/agent.ts`** (`maxInputTokensPerSession` 250k,
      `maxOutputTokensPerSession` 20k; env-tunable). *(P2.6)*
- [ ] ⏳ **Activate the AI Gateway hard spend cap** (`AI_GATEWAY_MODEL` + Azure-EU BYOK) —
      code already routes through the Gateway when the env is set; do the Gateway/BYOK +
      spend-cap config in the Vercel dashboard. *(P2.6/D2)*
- [x] ✅ **Cap chat input length** before the model call — Content-Length gate in
      `agent/channels/eve.ts` (16 KB default, env-tunable). *(G1)*
- [ ] ⏳ **Move rate limiting to Vercel Firewall** (distributed) for `/eve/v1/*` **and**
      `/api/contact` — dashboard rules. The per-session token cap (above) already bounds turns
      per session. *(G7)*
- [x] ✅ **Stop logging contact PII** — logs field sizes only (`safeShape`), never values. *(G4)*
- [x] ✅ **Wall-clock timeout on the contact route** (`maxDuration = 30`). ⏳ The eve streaming
      route's timeout must be set in the dashboard/`vercel.json` (not an authored file — left
      untouched to avoid truncating streams). *(P2.6)*

**🟠 High-value — do before or immediately after launch**

- [ ] ⏳ **Verify prompt caching fires in production** (`cachedInputTokens>0`), and keep the
      prompt prefix byte-stable (no per-request interpolation). *(P3.7 — 55–65% cost)*
- [ ] 🕓 **Deploy the shorter prompt (V3/candidate)** gated on `npm run eval:run`. *(P3.8/9 —
      deferred by request)*
- [ ] 🕓 **Evaluate gpt-4.1-mini** (or dynamic routing) on the eval set. *(D3 — deferred by
      request)*
- [ ] ⏳ **Confirm content-filter/4xx are not retried** on the production path (one billed
      call, not three). *(P1.2 — verification)*
- [ ] ⏳ **Wire the contact email/SMTP fallback** so leads survive a Salesforce outage — needs
      the `nodemailer` dependency + `SMTP_*` creds (not added unprompted). *(G5)*
- [x] ✅ **Idempotency on contact submit** (`Idempotency-Key` header) to prevent duplicate
      Cases. ⏳ Soft/per-instance — move to Vercel KV to be fleet-authoritative. *(P1.3)*

**🟡 Optimization & hardening**

- [ ] **Alerts**: model error rate, cache-hit-ratio drop, p95 TTFT, daily spend. *(G6)*
- [ ] **`LANGSMITH_TRACE_COMPLETENESS=ai`** in high-traffic prod to trim exported spans.
      *(P2.5)*
- [ ] **Log (don't block) prompt-injection heuristics** to LangSmith for monitoring. *(G2)*
- [ ] **Add a friendly chat fallback message** on stream-failure events. *(G5)*
- [ ] **Guard test: assert 0 tools** so the no-loop invariant can't regress. *(P1.1)*
- [ ] **Confirm `vercel.json` `frame-ancestors`/CSP** restricts widget embedding. *(D6)*
- [ ] **Fix the `~41.5k`→`~16.7k` token figure** in `CLAUDE.md`. *(docs accuracy)*
- [ ] **Set `LANGSMITH_RECORD_IO` OFF in prod** unless a DPA covers content capture. *(G4)*

---

### Bottom line

Navio's architecture is unusually clean for cost/security review — **no tools means no
reasoning-loop blowups, no tool-authz surface, and a small injection blast radius.** The work
that remains is not about taming an agentic loop; it's about (1) **bounding a public anonymous
endpoint** (`limits` + Gateway cap + distributed rate limiting + input caps), (2) **exploiting
the one big recurring cost** (cache the 16.7k prompt, shorten it, right-size the model), and
(3) **two hygiene fixes** (committed secrets, PII in logs). Ship the 🔴 list first.

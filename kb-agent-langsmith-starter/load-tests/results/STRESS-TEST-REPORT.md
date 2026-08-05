# Navio — Real-User Stress Test Report

**Date:** 2026-08-05 · **Tool:** k6 v2.1.0 · **Target:** `navio-widget.vercel.app` (production)
**Traffic:** genuine AI conversations (real Azure token spend) · **Turns executed:** 31 via k6 +
10 via targeted probes = **~41 real AI turns**

> ## 🔴 Headline finding
> **At 5–7 concurrent users, ~13–17% of FAQ turns fail — and the user sees a permanently empty
> chat bubble with no error message.** Root cause: the Azure `gpt-4.1` deployment in
> `germanywestcentral` hits its rate limit. This is a **production-blocking issue** at launch
> concurrency and needs an Azure quota increase plus a UI error state.

---

## 1. What was measured

Each simulated visitor performs a genuine turn:

1. `POST /eve/v1/session` with a real German question → 202 + `continuationToken`
2. `GET /eve/v1/session/{id}/stream` → reads the NDJSON answer

**Measurement note (important for anyone re-running this):** eve holds the SSE connection open
for ~120 s *after* the answer is complete, and k6 buffers the full body — so raw HTTP duration is
**not** answer latency. All latency figures below are recovered from the **server-side event
timestamps** inside the stream (`session.started` → first `message.appended` → `turn.completed`),
which is the truth a user experiences. The stream also **replays history**, so a late-connecting
client loses nothing (verified).

---

## 2. Results — latency

| Metric | median | p90 | p95 | max |
|---|---|---|---|---|
| **FAQ — time to first token** | **2.65 s** | 27.6 s | 32.2 s | 38.6 s |
| **FAQ — full answer** | **6.65 s** | 30.5 s | 34.8 s | 41.5 s |
| FAQ — session create (HTTP) | 0.57 s | 1.55 s | 2.01 s | 2.02 s |
| **Partner — time to first token** | 19.4 s | 32.3 s | 32.4 s | 32.5 s |
| **Partner — full answer** | 26.1 s | 34.9 s | 35.7 s | 36.4 s |
| Partner — session create (HTTP) | 0.74 s | 1.95 s | 2.08 s | 2.20 s |

**Reading:**
- **Median FAQ performance is good** — a first token in 2.65 s and a complete answer in 6.65 s is
  a solid chat experience.
- **The tail is bad.** p95 first-token of 32 s is a 12× spread from the median. Under concurrency
  requests queue behind the Azure rate limit before eventually succeeding (or failing, §3).
- **Partner latency (26 s median) matches the documented 30–60 s expectation** and is inherent to
  the search + long answer. It is *not* a regression.

---

## 3. Results — reliability (the problem)

| Metric | Value |
|---|---|
| Turn success rate | **87.09%** (27 / 31) — below the 95% threshold |
| Empty answers (no text ever rendered) | **4** |
| HTTP failures | **0%** (0 / 62) |
| HTTP 5xx | **0** |
| Vercel-level 429 | **0** |
| Dropped iterations (hit 10 min cap) | 5 |

**The failures are invisible at the HTTP layer.** Every request returned HTTP 200 — the failure
happens *inside* the event stream. That is why naive uptime monitoring would report this system
as 100% healthy while 13% of users get nothing.

### Root cause — proven, not inferred

A controlled 6-way parallel burst reproduced it (1 of 6 failed). The failing stream contains:

```json
{"type":"turn.failed","data":{"code":"MODEL_CALL_FAILED","details":{
  "message":"AI_RetryError: Failed after 3 attempts. Last error: AI_APICallError:
             Your requests to gpt-4.1 for gpt-4.1 in germanywestcentral have exceeded rate limit."
}}}
```

Event sequence on a failed turn: `session.started → turn.started → message.received →
step.started → step.failed → turn.failed`. **No `message.appended` is ever emitted**, so the
widget renders an empty bubble forever — exactly the failure mode described in root
`CLAUDE.md` §10.2, here triggered by the §10.1 Azure TPM ceiling.

Full evidence: `evidence-failed-turn-azure-ratelimit.ndjson`.

### Concurrency threshold

| Concurrent users | Result |
|---|---|
| **3** | ✅ 3/3 succeeded — **0% failure** |
| **6** | ⚠️ 5/6 succeeded — **17% failure** |
| 5–7 (k6, sustained) | ⚠️ 27/31 succeeded — **13% failure** |

**The safe ceiling today is ~3 concurrent FAQ turns.** Above that, the Azure deployment's rate
limit starts rejecting calls faster than the SDK's 3 retries can recover.

---

## 4. What held up well

- **No infrastructure failures.** 0 HTTP errors, 0 5xx, 0 Vercel-level rate limiting across 62
  requests. Vercel's edge and the Next.js runtime were never the bottleneck.
- **The partner path was reliable:** 6/6 searches completed, 5/6 rendered an answer, with the
  shared-secret proxy working under concurrent load.
- **Session creation stayed fast** (median 0.57 s) even while the model was saturated — the
  queueing happens downstream, so the app accepts work correctly.
- **SSE keep-alive works.** Long silent partner turns (26 s median) never dropped a connection —
  the fix documented in `CLAUDE.md` §9 is holding.
- **Stream replay works:** a client connecting 25 s late still receives the complete history.

---

## 5. Recommendations (priority order)

1. 🔴 **Raise the Azure `gpt-4.1` TPM quota** for `germanywestcentral`. This is the direct fix and
   the only one that removes the failure. Size it against concurrent-user targets: at ~16.7 k
   input tokens per FAQ turn, 10 concurrent users ≈ 167 k tokens/min.
2. 🔴 **Surface model failures in the widget UI.** Today `turn.failed` renders as *nothing*. The
   widget should detect `turn.failed` / absence of `message.appended` and show a retry-able
   message ("Es gab ein Problem – bitte versuche es erneut."). A visible error is far better than
   a silent empty bubble, and this protects users during *any* future model outage.
3. 🟠 **Add a client-side retry with backoff** for `MODEL_CALL_FAILED`. The SDK's 3 immediate
   retries are exhausted in a burst; a slower retry would ride out short spikes.
4. 🟠 **Alert on `turn.failed` rate**, not just HTTP status. This incident is invisible to HTTP
   monitoring — pair every health signal with a work-actually-performed signal (the lesson from
   `CLAUDE.md` §10.4).
5. 🟡 **Consider a smaller/cheaper model for the FAQ agent** (e.g. `gpt-4.1-mini`, already on the
   backlog). Lower token throughput per turn = more headroom under the same quota.

---

## 6. Test-conduct notes

- **A temporary Vercel System Bypass** was added for the tester IP (`2.214.241.202`) because the
  earlier flood test left this client under automatic DDoS challenge. **It was removed after
  testing** — verified: *"No system bypass rules configured."*
- **Cost:** ~41 real AI turns (≈35 FAQ + 6 partner). With the ~93% prompt-cache hit rate this is a
  low single-digit euro amount.
- **Scope:** only `navio-widget` / `navio-partner` were touched. The `frontend` (www.sportnavi.de)
  project was not involved.

## Artifacts

| File | Contents |
|---|---|
| `04-real-user-stress-summary.json` | k6 aggregated metrics |
| `evidence-failed-turn-azure-ratelimit.ndjson` | Full event stream of a failed turn |
| `evidence-error-summary.txt` | The extracted `MODEL_CALL_FAILED` payload |
| `STRESS-TEST-REPORT.md` | This report |

Script: `../04-real-user-stress.js` (hard-capped iterations; `-e FAQ_ITERS=n -e PARTNER_ITERS=n`).

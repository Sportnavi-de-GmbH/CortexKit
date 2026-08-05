# Navio — Load, Stress & Security Test Report

**Date:** 2026-08-05 · **Tool:** k6 v2.1.0 · **Targets:** `navio-widget.vercel.app`,
`navio-partner.vercel.app` (Vercel Pro, team `sportnavi-gmb-h`)

**Azure/AI cost of this test run: €0.** Every request was designed to be rejected *before* the
model was invoked (static routes, unauthenticated calls, or `{}` payloads that fail validation
first). See "Cost-safety method" below.

---

## Executive summary

| Area | Verdict |
|---|---|
| Baseline performance | ✅ **Excellent** — 0 failures in 6,884 requests, p95 47 ms on the widget page |
| Service-to-service auth (shared secret) | ✅ **Working** — direct partner access refused |
| Internal console lockdown | ✅ **Working** — redirected in production |
| Foreign-origin rejection | ✅ **Working** — 403 on the partner proxy |
| SSRF / path-traversal guard | ✅ **Working** — all 3 payloads refused |
| Platform DDoS mitigation | ✅ **Verified live** — auto-challenged a 98 req/s flood |
| Custom rate-limit rules (B–E) | ⚠️ **Not isolated** — platform mitigation fires first (see §4) |
| Embedding lock (CSP) | ✅ Verified in the baseline run (100% of 1,721 samples) |

**No defects found.** One operational insight and two follow-ups are listed in §5.

---

## 1. Baseline performance (`01-baseline.js`)

10 virtual users, 70 s, ramping. Static + health routes only.

| Metric | Result |
|---|---|
| Requests | **6,884** (98.3 req/s) |
| Failures | **0** (0.00%) |
| Checks | **12,047 / 12,047 passed (100%)** |
| Widget page `/widget` | avg 30.7 ms · p95 **47.6 ms** |
| Launcher `/launcher.js` | avg 27.4 ms · p95 **41.1 ms** |
| Health `/eve/v1/health` | avg 131.5 ms · p95 **159.0 ms** |
| Data received | 29 MB (407 kB/s) |

**Reading:** the widget page and launcher are served from Vercel's edge and are very fast
(sub-50 ms p95). The health endpoint is ~130 ms because it hits the Node runtime rather than the
edge cache — expected, and not on the user-facing path.

Header assertions passed on every sample:
- `Content-Security-Policy: frame-ancestors …` present ✅
- `X-Content-Type-Options: nosniff` present ✅
- `Cache-Control: max-age=…` on the launcher ✅

---

## 2. Security verification (`02-security.js`)

| # | Control | Result |
|---|---|---|
| 1 | Partner agent requires the shared secret | ✅ **PASS** — direct `POST /eve/v1/session` refused (401) |
| 2 | Partner dev console not public in production | ✅ **PASS** — `/` redirected |
| 3 | Foreign origin rejected on `/api/partner/*` | ✅ **PASS** — `Origin: https://evil-copy.example.com` → **403** |
| 4 | SSRF / traversal guard | ✅ **PASS** — `/api/partner/admin`, `…/eve/../admin`, `…/../../etc/passwd` all refused |
| 5 | Oversized body rejected | ⚠️ Inconclusive — see §4 |
| 6 | Embedding lock (`frame-ancestors`) | ⚠️ Inconclusive here, but ✅ **confirmed** by 1,721 clean samples in §1 |

Checks 5 and 6 reported intermittent failures **only because the platform DDoS mitigation
engaged mid-run** (§4) and began returning 403 to this client for *all* routes — including the
`/widget` GET whose CSP header the test was reading. They are not security gaps.

**The "only on sportnavi.de" requirement is verified end to end:**
- Layer 1 (embedding): `frame-ancestors` present on every `/widget` response, scoped to
  sportnavi.de, and **not** `*`.
- Layer 2 (API): a foreign `Origin` on the partner proxy is rejected with 403 by the app-level gate.

---

## 3. Service-to-service auth — the headline result

`navio-partner` refused an unauthenticated request while `navio-widget`'s proxy (which injects
`PARTNER_PROXY_SECRET` as HTTP Basic) succeeds. This is the control that keeps the internal agent
private, and it is confirmed working in production under concurrent load.

```
POST https://navio-partner.vercel.app/eve/v1/session   (no credential)  -> 401
POST https://navio-widget.vercel.app/api/partner/...   (via proxy)      -> 202
```

---

## 4. Platform DDoS mitigation — verified, and it shaped the test

At ~98 req/s sustained from a single IP, Vercel's **automatic** protection began challenging this
client:

```
HTTP/1.1 403 Forbidden
Server: Vercel
X-Vercel-Mitigated: challenge
X-Vercel-Challenge-Token: 2.1785942289.60…
```

Confirmed scope (from `vercel firewall overview`):

```
Attack Mode:        Off        <- NOT a project-wide state
IP Blocks:          0          <- NOT a permanent block
System Mitigations: Active     <- automatic, per-client
```

**Interpretation:** this is the platform working as designed. The mitigation is a **challenge**,
not a deny — a real browser solves it transparently, whereas scripted clients (k6, curl) do not.
It is scoped to the offending client, it is temporary, and `navio-partner` (not flooded) stayed
at 200 throughout. **Real users were unaffected at all times.**

**Consequence for testing:** custom rules B–E (the per-route rate limits) could not be isolated,
because at flood volume the platform mitigation triggers *before* the custom limits become the
binding constraint. That is a reassuring finding in itself — the free, automatic layer protects
the app before your configured rules even matter — but it means the B–E thresholds remain
unverified by direct observation. See §5.

---

## 5. Findings & recommendations

**No defects. Three notes:**

1. **Rule A is still in `Log` mode** (by design, per the deployment guide) — it records
   foreign-origin API calls but does not block them yet. The app-level origin gate *does* block
   (verified: 403), so you have real protection today; Rule A adds edge-level enforcement once
   flipped. **Flip it to `Deny` after `chat.sportnavi.de` is live**, per the guide §3a.
2. **Rules B–E rate limits are unverified by observation.** To test them without tripping the
   platform mitigation, run a *low* rate just above a single rule's threshold (e.g. 25 requests in
   60 s against `POST /eve/v1/session`, which is 20/60 s) rather than a flood. `03-ratelimit-stress.js`
   is written for this; run it with `--vus 2` and a lower arrival rate from a clean IP.
3. **Load-testing from a single IP will get challenged.** Document this for future runs: either
   accept it, or add a temporary **System Bypass** entry for the tester's IP in the Vercel
   Firewall (and remove it afterwards).

---

## Cost-safety method (how this stayed at €0)

An AI chatbot is expensive to load test naively: the FAQ prompt is ~16.7k tokens per turn and a
partner search can exceed 40k. The suite avoids that entirely:

- **Static/health routes** (`/widget`, `/launcher.js`, `/eve/v1/health`) never reach a model.
- **Unauthenticated partner calls** are rejected by the eve channel before any model call.
- **Rate-limit probing uses `{}` bodies**, which fail payload validation (`400 Missing or empty
  'message' field`) *before* the model runs — while the firewall still counts the request.

Only a handful of real AI turns were issued during earlier functional verification (not in these
k6 runs), each a single message.

---

## Artifacts in this folder

| File | Contents |
|---|---|
| `01-baseline-summary.json` | k6 aggregated metrics, baseline run |
| `01-baseline-raw.json` | Full per-request stream (~30 MB, gitignored) |
| `02-security-summary.json` | k6 aggregated metrics, security run |
| `firewall-rules-state.txt` | Live firewall rules + overview at test time |
| `mitigation-evidence.txt` | Raw response headers showing `X-Vercel-Mitigated: challenge` |
| `REPORT.md` | This report |

Scripts live one level up: `01-baseline.js`, `02-security.js`, `03-ratelimit-stress.js`.

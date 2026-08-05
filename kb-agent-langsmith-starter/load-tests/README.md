# Navio load & security tests (k6)

Performance, stress, and security verification for the two Navio services. Written to be
**safe to run against production**: no test in this suite spends Azure/OpenAI tokens.

Latest results and full analysis: [`results/REPORT.md`](results/REPORT.md).

## Prerequisites

```bash
winget install --id GrafanaLabs.k6 -e     # Windows
brew install k6                            # macOS
```

## Run

```bash
cd kb-agent-langsmith-starter/load-tests

# 1. Baseline performance (static + health routes only)
k6 run --summary-export=results/01-baseline-summary.json 01-baseline.js

# 2. Security controls (auth lock, origin, traversal, CSP, console lockdown)
k6 run --summary-export=results/02-security-summary.json 02-security.js

# 3. Rate-limit probing — see the warning below before running
k6 run --summary-export=results/03-ratelimit-summary.json 03-ratelimit-stress.js
```

Override targets with env vars:

```bash
k6 run -e WIDGET_URL=https://chat.sportnavi.de -e PARTNER_URL=https://partner.sportnavi.de 01-baseline.js
```

## ⚠️ Two things to know before running

**1. High request rates get challenged.** Vercel's automatic DDoS mitigation challenges a single
IP sending ~100 req/s (`X-Vercel-Mitigated: challenge`, HTTP 403 to *all* routes for that client).
This is correct platform behaviour, it is temporary, and it does not affect real users — but it
will pollute your results. To probe the custom rate-limit rules (B–E), use a **low** arrival rate
just above one rule's threshold (e.g. 25 requests in 60 s against `POST /eve/v1/session`, limit
20/60 s), not a flood. Alternatively add a temporary **System Bypass** for the tester's IP in the
Vercel Firewall and remove it afterwards.

**2. Never load test with real chat messages.** The FAQ prompt is ~16.7k tokens per turn and a
partner search can exceed 40k (see the root `CLAUDE.md` §10.1). A few hundred real turns would
cost real money and can exhaust the Azure TPM quota, taking the live widget down. These scripts
deliberately use:

- static/health routes that never reach a model,
- unauthenticated partner calls (rejected by the eve channel), and
- `{}` payloads that fail validation with `400` *before* the model runs, while the firewall still
  counts the request.

Keep that property if you extend the suite.

## What each script covers

| Script | Covers | AI cost |
|---|---|---|
| `01-baseline.js` | Latency/throughput of `/widget`, `/launcher.js`, both `/eve/v1/health`; asserts CSP + `nosniff` + cache headers | none |
| `02-security.js` | Partner shared-secret lock, console lockdown, foreign-origin rejection, SSRF/traversal guard, oversized body, `frame-ancestors` | none |
| `03-ratelimit-stress.js` | Firewall rules B–E via invalid payloads; `-e TARGET=contact` switches to the contact route | none |

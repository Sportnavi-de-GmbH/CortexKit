# 9. Website Integration and Security

> **Status: mostly PLANNED / TARGET.** Today this repository is the agent +
> evaluation harness with a local dev console. The public website widget, the
> Vercel-hosted secure endpoint, and the network protections below are the
> **intended production model**. The bot-protection piece is now in motion — the
> `botid` (Vercel BotID) dependency was just added to the stack. This document
> describes the target architecture and the reasoning; in-prompt security
> (anti-injection) is already implemented.

## In plain terms

The chatbot will live on the public Sportnavi website with **no login** — any
visitor can use it. That's great for customers but risky: a public, anonymous AI
endpoint can be abused (spam, scraping, running up the model bill) and must never
expose secret keys. So the bot sits behind a **secure layer** that hides the keys,
detects bots, limits how fast anyone can call it, and watches the spend.

## 9.1 The current situation

- **No login required** — public, anonymous access.
- **Embedded as a website widget** — a small chat component on the Sportnavi site.
- Because it's anonymous and public, **all protection happens at the
  infrastructure layer**, not via user accounts.

## 9.2 The security model (target)

```
Visitor (anonymous)
   ↓  HTTPS
Sportnavi Website Widget            (browser — holds NO secrets)
   ↓
Secure Backend / API Layer (Vercel)
   • Secrets kept server-side (Azure + LangSmith keys never reach the browser)
   • Bot detection            (Vercel BotID — `botid`)
   • Rate limiting            (per visitor/IP/session)
   • Budget / cost guardrail  (cap spend per window)
   • Request validation / firewall rules
   ↓
EVE Agent  →  Azure OpenAI (gpt-4.1)
```

### How the widget is integrated
A lightweight embeddable component on the public site sends the visitor's message
to the Vercel backend and streams the reply back. It contains **no API keys** —
it only talks to our own backend.

### How API keys and secrets are protected
Every credential (Azure OpenAI key, LangSmith key) lives **server-side** in
environment variables and is never shipped to the browser. The widget can only
reach our backend, which holds the keys and calls Azure on the visitor's behalf.
The agent is already designed to run **credential-free for observability** (no
LangSmith key = no-op), so only the Azure key is strictly required to answer.

### How abuse is prevented
- **Bot detection — Vercel BotID (`botid`).** Invisible detection that blocks
  automated clients (scrapers, scripted abuse) from hammering the public endpoint,
  without adding friction (no CAPTCHA) for real users.
- **Rate limiting.** Caps requests per visitor/session/IP so no single actor can
  flood the endpoint or run up cost. This is essential for an *anonymous* endpoint
  where you can't throttle by account.
- **Firewall / request validation.** Reject malformed or oversized requests at the
  edge before they reach the model.

### How prompt-level abuse is handled (already implemented)
Beyond network protection, the **system prompt itself** contains a security block
that makes the model refuse prompt injection, jailbreaks, role-play/persona
swaps, "developer mode," encoded (e.g. Base64) instructions, and any attempt to
extract its system prompt or capture personal data. This is validated by the
security suite in the evaluation benchmark ([05](05-experiment-analysis.md)) —
these samples are expected to be refused/blocked (counted as "safety passes").

### How cost is protected
- **Budget monitoring** — spend is tracked per answer and (in production) per time
  window, with a cap so runaway usage can't produce a surprise bill.
- **The prompt-embedded design helps here:** Azure caches the ~16k-token prefix,
  so ~99% of each request is billed at the cheap cached rate.

### How it's monitored
- **LangSmith traces** already give per-answer cost/latency/tokens.
- In production, add **online evaluators** and **anomaly alerts** (error spikes,
  cost spikes, latency spikes) on live traffic.

## 9.3 Deployment (target)

- **Vercel** hosts the secure API layer and the eve agent (`next.config.mjs`
  already uses `withEve({})` so the agent can run alongside a Next.js app).
- Environment variables (secrets) configured in Vercel, never in the repo.
- HTTPS everywhere; the widget only ever calls our own origin.

## 9.4 Future authentication possibilities

Anonymous is right for a public FAQ bot. If Navio later needs to answer
**account-specific** questions (a member's own billing, a company's contract),
that requires authentication:
- Log the member in (or verify via the existing Sportnavi account system) so the
  bot can safely access their data.
- Combine with retrieval (RAG) to fetch the authenticated user's records.
Until there's a need for personalized/private answers, anonymous + strong
infrastructure protection is the correct, lower-risk posture.

## 9.5 Why this approach

A public, anonymous LLM endpoint is fundamentally a **spend-and-abuse target**.
The only robust defenses are at the infrastructure layer (hide secrets, detect
bots, rate-limit, cap budget) plus in-prompt refusal of manipulation. Because we
can't gate by user account, **rate limiting and bot detection are not optional** —
they're what make a keyless public endpoint safe to operate.

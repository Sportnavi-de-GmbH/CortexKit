# CortexKit — Navio (Sportnavi's AI chat widget)

**Navio** is Sportnavi's public, anonymous, login-less **chat widget** for
[sportnavi.de](https://sportnavi.de) — a German corporate-fitness network. It's added to the
website with **one `<script>` tag** and opens in an iframe. One widget offers **three things**
behind a single menu, powered by **two AI agents** plus a contact form.

> **New here?** This README is the overview. For deep detail see **[`docs/`](docs/)** (numbered
> project docs) and the **canonical deployment + security guide**:
> [`kb-agent-langsmith-starter/docs/deployment/VERCEL-DASHBOARD-GUIDE.md`](kb-agent-langsmith-starter/docs/deployment/VERCEL-DASHBOARD-GUIDE.md).

---

## The Navio menu

A visitor clicks the floating button → the widget opens → a one-time **GDPR consent** gate →
the **menu**. The menu has **three cards**:

| Card | What it does | Powered by |
|---|---|---|
| 🤖 **FAQ-Agent** | Answers questions about the product, tariffs, check-in, cashback, contracts — "How does Sportnavi work?" | **FAQ/KB agent** — knowledge baked into the prompt, **no tools, no database** |
| 📍 **Partner finden** | Finds real studios & courses near a city — "Yoga in Bochum" | **Partner agent** — a separate service with a live directory (RAG over Supabase + embeddings) |
| ✉️ **Kontaktformular** | Sends a message to the Sportnavi team | A server-side **Salesforce** case |

Every screen has a ← back arrow to the menu. The full screen flow is
`greeting → consent → menu → {chat | partner | contact | info}`.

**Design rule (don't break):** the palette is deliberately two-colour — **green `#95c11e`** is the
single "AI / call-to-action" colour (both chat cards) and **orange `#ec6607`** means "human
hand-off" (only the contact card). Fonts: Outfit + Inter. See
[`kb-agent-langsmith-starter/docs/design/WIDGET-DESIGN-GUIDELINES.md`](kb-agent-langsmith-starter/docs/design/WIDGET-DESIGN-GUIDELINES.md).

---

## Architecture — two services, one repository

Navio runs as **two programs** ("services"), both living in **this one repository** and deployed
as **two Vercel projects** (told apart by their Root Directory):

```
                       sportnavi.de
                            │  <script src="https://chat.sportnavi.de/launcher.js" async>
                            ▼
   ┌────────────────────────────────────────────────────────────┐
   │ SERVICE 1 — Navio widget   (kb-agent-langsmith-starter)     │  public, browser-facing
   │   /widget          the iframe UI + the three-card menu      │
   │   /eve/v1/*         FAQ agent (no tools, KB in the prompt)  │
   │   /api/contact      Salesforce contact form (server-only)   │
   │   /api/partner/*  ──┐ same-origin proxy (adds a shared      │
   └─────────────────────┼─ secret, keep-alive, no CORS)         │
                         ▼
   ┌────────────────────────────────────────────────────────────┐
   │ SERVICE 2 — Partner agent  (SportnaviPartnerRecomandationBot│  internal, never called by the browser
   │                             /partner-recommendation-agent)  │
   │   /eve/v1/*   find studios → Supabase directory + embeddings│
   └────────────────────────────────────────────────────────────┘
```

**Why a proxy?** The browser only ever talks to **one origin** (Service 1). Anything about the
product is answered by the FAQ agent right there; a "find a studio" request is relayed by
Service 1's proxy to Service 2 on the server side. This keeps the consent gate, origin lock, bot
protection, and firewall rules covering partner requests too — and the proxy authenticates itself
to Service 2 with a **shared secret** (`PARTNER_PROXY_SECRET`), so Service 2 stays private.

**Request flow:** `Visitor → Widget → Vercel → Proxy/API → Agent → answer`.

---

## Repository structure

```
CortexKit/                                   ← one GitHub repo; both services live here
├── kb-agent-langsmith-starter/              ← SERVICE 1 — the Navio widget (Next.js + eve)
│   ├── agent/
│   │   ├── instructions.md                  ←   the FAQ system prompt + knowledge base
│   │   ├── channels/eve.ts                  ←   public API auth (size cap → BotID → origin lock)
│   │   └── tools/                            ←   11 disabled built-ins (FAQ agent is tool-free)
│   ├── app/
│   │   ├── widget/                           ←   the embeddable widget page (mounts both agents)
│   │   ├── api/partner/[...path]/            ←   same-origin proxy to Service 2
│   │   └── api/contact/                      ←   Salesforce contact endpoint
│   ├── components/navio/                     ←   NavioWidget, NavioMenu, contact form
│   ├── lib/partner-proxy.ts                  ←   proxy logic (SSRF guard, shared secret, keep-alive)
│   ├── public/launcher.js                    ←   the one-line embed script
│   ├── docs/deployment/                      ←   deployment + security guides (start with the dashboard guide)
│   ├── evals/  scripts/  tests/              ←   evaluation datasets, runners, unit tests
│   └── next.config.mjs                       ←   frame-ancestors (embedding lock), BotID, redirects
│
├── SportnaviPartnerRecomandationBot/         ← SERVICE 2 — Partner agent (regular folder in THIS repo)
│   └── partner-recommendation-agent/
│       ├── agent/                            ←   agent config, instructions, channels/eve.ts (shared-secret auth)
│       └── lib/partners/                     ←   deterministic search pipeline (no LLM math)
│
├── docs/                                     ← numbered project documentation (01–11 + index)
└── .env.local / .mcp.json                    ← local secrets — GITIGNORED, never committed
```

> ℹ️ A standalone `SportnaviPartnerRecomandationBot` repo exists on GitHub but is **out of date and
> unused** — the Partner agent's live code is the folder above, inside `CortexKit`. Deploy and
> commit everything from `CortexKit`.

---

## Run it locally (both services)

```powershell
# terminal 1 — Partner agent (Service 2)
cd SportnaviPartnerRecomandationBot/partner-recommendation-agent
npm install
npm run dev:ui -- -p 3001

# terminal 2 — Navio widget (Service 1)
cd kb-agent-langsmith-starter
npm install
# .env.local: set PARTNER_AGENT_HOST=http://127.0.0.1:3001  (use 127.0.0.1, not localhost)
#             and PARTNER_PROXY_SECRET (same value in both services, optional locally)
npm run dev:ui -- -p 3010
```

Open **http://localhost:3010/widget** and try all three cards. (The FAQ agent works with just the
Azure keys; "Partner finden" needs Service 2 running and `PARTNER_AGENT_HOST` set.)

Common commands (run inside `kb-agent-langsmith-starter`):

| Command | Purpose |
|---|---|
| `npm run dev:ui` | Next.js console + widget (normal way to run) |
| `npm run typecheck` / `npm test` | must be green before committing |
| `npm run eval:dev` / `eval:run` | evaluate a prompt change (fast subset / full set) |

---

## Deploy to production

Everything you need is in the **canonical guide**, written for a non-technical owner
(§1 architecture → §8 launch checklist):
**[`kb-agent-langsmith-starter/docs/deployment/VERCEL-DASHBOARD-GUIDE.md`](kb-agent-langsmith-starter/docs/deployment/VERCEL-DASHBOARD-GUIDE.md)**
(CLI version: [`VERCEL-RUNBOOK.md`](kb-agent-langsmith-starter/docs/deployment/VERCEL-RUNBOOK.md);
the deeper "why": [`PUBLIC-WIDGET-DEPLOYMENT.md`](kb-agent-langsmith-starter/docs/deployment/PUBLIC-WIDGET-DEPLOYMENT.md)).

In short: **two Vercel projects from this one `CortexKit` repo**, deployed **partner agent first**,
differing only by Root Directory:

| # | Project | Repo | Root Directory |
|---|---|---|---|
| 1 | navio-widget (public) | `CortexKit` | `kb-agent-langsmith-starter` |
| 2 | navio-partner (internal) | `CortexKit` (same repo) | `SportnaviPartnerRecomandationBot/partner-recommendation-agent` |

Then set Service 1's `PARTNER_AGENT_HOST` to Service 2's URL and the **same
`PARTNER_PROXY_SECRET`** on both projects, and redeploy.

---

## How Navio is kept secure

Defense in depth — no single layer is enough:

- **Embedding lock** — `WIDGET_FRAME_ANCESTORS` (a browser `frame-ancestors` rule) means the widget
  **only loads on sportnavi.de**; a copy on another site is refused by the browser.
- **Origin lock** — a Vercel Firewall rule denies API calls whose `Origin` isn't a sportnavi domain.
- **Bot protection** — Vercel **BotID** turns away automated traffic on chat-start.
- **Rate limits** — Vercel Firewall caps chat-starts, messages, partner searches, and the contact form.
- **Cost cap** — Azure Tokens-Per-Minute limit + budget alert (optionally a Vercel AI Gateway dollar cap).
- **Service-to-service auth** — the proxy authenticates to the Partner agent with a **shared secret**,
  so Service 2 is not publicly usable.

Full step-by-step: the deployment guide, §3–§8.

---

## Conventions

- **The prompt is the product.** Change the FAQ agent's behaviour/facts by editing
  `kb-agent-langsmith-starter/agent/instructions.md`; the Partner agent's by editing its own
  `instructions.md`. Always evaluate (`npm run eval:dev`) before promoting a change.
- **Secrets never get committed.** `.env.local`, `.mcp.json`, and local config files are gitignored;
  only placeholders live in `.env.example`. Rotate any key that was ever shared.
- **Keep the FAQ agent tool-free** and the Partner agent at **two tools** — every advertised tool
  costs schema tokens on every model call.
- **Two services, one repo.** Both are deployed from `CortexKit`; commit changes to either here.
- **Framework-locked layout** — don't relocate `agent/`, `app/`, `lib/`, `tests/`, `evals/`, or the
  root config files; paths are expected by Next.js / eve.

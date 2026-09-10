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

## Host on Vercel — step by step (anyone can follow)

You will create **two Vercel projects from this one `CortexKit` repository**, told apart only by
their **Root Directory** (the sub-folder Vercel builds). Deploy the **Partner agent first**,
because the widget needs its address.

> **Words used below:** **Vercel** = the hosting service ([vercel.com](https://vercel.com)).
> **Import** = connect a GitHub repo to Vercel. **Root Directory** = which sub-folder to build.
> **Environment variable** = a saved setting (a key or address) you type into Vercel, never into
> the code. **Deploy** = publish it live.

### The workflow at a glance

```
  Step 0  Prerequisites (GitHub access, Vercel account, the env values)
     │
  Step 1  Import project 2 (Partner agent)  ──►  set Root Directory  ──►  add env vars  ──►  Deploy
     │                                                                         │
     │                                                          copy its URL ◄─┘
     ▼
  Step 2  Import project 1 (Widget)  ──►  set Root Directory  ──►  add env vars (incl. that URL
     │                                    + the shared secret)  ──►  Deploy
     ▼
  Step 3  Test all three menu cards on the temporary *.vercel.app address
     │
  Step 4  Turn on security  (Firewall rules → Bot protection → Spend cap)
     │
  Step 5  Add the real domain (chat.sportnavi.de) → embed the one-line script → go live
```

> 📖 This is the quick path. For the **exhaustive, non-technical version with every click,
> firewall rule, and screenshot-level detail**, follow the canonical guide:
> **[VERCEL-DASHBOARD-GUIDE.md](kb-agent-langsmith-starter/docs/deployment/VERCEL-DASHBOARD-GUIDE.md)**.

### Step 0 — What you need first

- Access to the **`CortexKit`** GitHub repo (both services live here — you do **not** need a
  separate Partner-agent repo).
- A **Vercel** account (the **Pro** plan unlocks the full firewall + bot protection; a free-plan
  fallback is in the canonical guide).
- The **environment values**: Azure OpenAI (endpoint, key, model), the Supabase database URL +
  **service-role** key, the embedding API URL + key, and one long random **shared secret** you
  invent now (used by both projects).
- Access to **sportnavi.de's DNS** for the custom-domain step.

⚠️ First, make sure secrets aren't in the code: `.env.local` and `.mcp.json` must stay
git-ignored (they already are), and rotate any key that was ever shared.

### Step 1 — Deploy the Partner agent (project 2) first

1. On **vercel.com** → **Add New… → Project** → **Import** the **`CortexKit`** repo. (First time:
   click **Install** to connect Vercel to GitHub.)
2. **Root Directory → Edit →** choose **`SportnaviPartnerRecomandationBot/partner-recommendation-agent`**.
   *(Mandatory — the wrong folder makes every address show "404".)*
3. Name it **`navio-partner`**.
4. Open **Environment Variables** and add:

   | Variable | Meaning |
   |---|---|
   | `AZURE_AI_CHATBOT_OPENAI_ENDPOINT` / `_API_KEY` / `_DEPLOYMENT_NAME` | The AI brain (address, password, model name). |
   | `MEMORY_SUPABASE_URL` / `MEMORY_SUPABASE_SERVICE_ROLE_KEY` | The partner database — use the **service-role** key (the normal one returns zero partners). |
   | `EMBEDDING_API_URL` / `EMBEDDING_API_KEY` | Turns text into numbers so the agent can find *similar* studios. |
   | **`PARTNER_PROXY_SECRET`** | Your long random shared secret. **Remember this exact value — project 1 needs the same one.** |

5. Click **Deploy**, then **copy the deployment URL** (e.g. `https://navio-partner.vercel.app`).

✅ **Checkpoint:** the build succeeds and you have the partner URL copied.

### Step 2 — Deploy the widget (project 1)

1. **Add New… → Project** → **Import `CortexKit` again** (yes, the same repo).
2. **Root Directory → Edit → `kb-agent-langsmith-starter`**. Name it **`navio-widget`**.
3. **Environment Variables:**

   | Variable | Meaning |
   |---|---|
   | `AZURE_AI_CHATBOT_OPENAI_ENDPOINT` / `_API_KEY` / `_DEPLOYMENT_NAME` | The FAQ agent's AI brain. |
   | **`PARTNER_AGENT_HOST`** | The **partner URL** you copied in Step 1. |
   | **`PARTNER_PROXY_SECRET`** | The **exact same** secret you set on project 2. |
   | `WIDGET_FRAME_ANCESTORS` | Sites allowed to embed the widget (defaults to sportnavi.de). |
   | `SALESFORCE_*` *(optional)* | Contact form. Blank ⇒ the form simulates success without saving. |

   Tick **Production** and **Preview** for each. The two `PARTNER_PROXY_SECRET` values **must
   match**.
4. Click **Deploy**.

✅ **Checkpoint:** you get a widget URL like `https://navio-widget.vercel.app`.

### Step 3 — Test all three cards

Open `https://<widget-url>/widget` → **Mit Navio chatten → Zustimmen**:

- **FAQ-Agent** → ask *"Was ist Firmenfitness?"* → it answers.
- **Partner finden** → *"Yoga in Bochum"* → real studios (wait 30–60s; the bubble is empty while
  it searches — that's normal). A **503** means `PARTNER_AGENT_HOST` is wrong; an **empty/401**
  answer means the two `PARTNER_PROXY_SECRET` values don't match.
- **Kontaktformular** → submits.

✅ **Checkpoint:** all three cards work — this proves the shared secret is correct end to end.

### Step 4 — Turn on security

On the **widget** project (Vercel → **Firewall**, **Bot Protection**, then **Azure**):

1. **Firewall rules** — add the origin lock + rate limits (start each in **Log**, review
   **Firewall → Traffic**, then switch to **Deny/429**). Exact rules: canonical guide §3.
2. **Bot protection** — enable **BotID**, set `BOTID_ENABLED` + `NEXT_PUBLIC_BOTID_ENABLED` =
   `true`, redeploy.
3. **Spend cap** — in the **Azure Portal**, set a Tokens-Per-Minute limit + a monthly budget alert.

✅ **Checkpoint:** rules are Active; a call from another site is blocked; a flood is rate-limited.

### Step 5 — Real domain + go live

1. **Widget project → Settings → Domains →** add **`chat.sportnavi.de`** (add the CNAME at DNS).
2. **Partner project →** add a non-obvious domain like `partner.sportnavi.de`; update the widget's
   `PARTNER_AGENT_HOST` to it and **redeploy**. Then flip Firewall **Rule A → Deny**.
3. **Embed** — give the web team one line for any sportnavi.de page:

   ```html
   <script src="https://chat.sportnavi.de/launcher.js" async></script>
   ```

✅ **Final checks:** the widget works on sportnavi.de; a copy on any other site is refused; a
flood returns 429; no secret is visible in the page source. Full launch checklist: canonical
guide §8.

---

## Put Navio on the Sportnavi websites — the guide for the website team

This section is written for whoever edits sportnavi.de. You do not need to know how Navio
works, only how to add one line to the website's template. Everything else, the chat itself,
the answers, the security, runs on Navio's own server and updates on its own.

### What you will get

A small round **green-on-black chat button** in the bottom-right corner of every page. When a
visitor clicks it, Navio opens as a floating window next to the button, about the size of a
phone screen; on phones it fills the whole screen. The visitor sees a greeting, then a short
**privacy notice with "Zustimmen" and "Ablehnen"**. Only after agreeing do they reach the three
options: ask a question (**FAQ-Agent**), find a studio or course nearby (**Partner finden**), or
write to the team (**Kontaktformular**, which creates a case in Salesforce). Navio answers in the
language the visitor writes in. The website itself is not changed in any other way.

### The one line

Paste this into the website so that it appears on **every page**:

```html
<script src="https://chat.sportnavi.de/launcher.js" async></script>
```

Two things to know about the address inside it:

- **`chat.sportnavi.de` is Navio's final home.** Until the tech team has switched that address
  on, use the current one instead: `https://navio-widget.vercel.app/launcher.js`. Ask the tech
  team which of the two is live today. Everything else in the line stays the same.
- The line never needs updating afterwards. Improvements to Navio appear on the site by
  themselves, because the button only *fetches* Navio from its server.

### Where to paste it

The goal is one place that every page shares, so the button shows up site-wide:

| Your website is built with | Put the line here |
|---|---|
| A CMS with a "header/footer scripts" field (WordPress themes and plugins, TYPO3 page templates, most site builders) | The **footer scripts** field, or just before the closing `</body>` tag of the main template |
| Plain HTML pages | Just before `</body>` in the shared layout or footer include |
| A tag manager, for example Google Tag Manager | A "Custom HTML" tag that fires on all pages. **Do not make it wait for cookie consent** (see the next point) |

**About cookie banners.** Navio brings its **own** consent step: no message or personal detail
is sent until the visitor presses "Zustimmen" inside the chat window. So the little launcher
button itself does not need to be blocked by the website's cookie banner. If your consent tool
is set to hold back all scripts until the visitor accepts cookies, the button will not appear
for visitors who decline, which is usually not what you want. Add the Navio line to the
category that is allowed to load right away.

### Which websites may show Navio

For security, Navio only opens inside pages that belong to Sportnavi. Right now that means
**www.sportnavi.de** and **sportnavi.de**. Anywhere else, the button appears but the chat
window stays empty, on purpose, and on a computer the browser's console shows a message about
"frame-ancestors".

If you want Navio on **another Sportnavi site** (a campaign page, a subdomain, a partner
portal, a staging copy of the website), ask the tech team to add that site's address first.
It is a small setting change and a quick re-publish on their side; no code is written. Do
this *before* you paste the line there, otherwise the window will be blank.

### Try it before it goes live

You do not have to test on the real website. There is a ready-made test page in this
repository, `embed-test/simple.html`, that shows the real, live Navio exactly as visitors will
see it. Anyone with this repository and Node.js installed can run `node embed-test/serve.js`
and open `http://localhost:8080/simple.html`. It is the fastest way to check the look and to
try all three options without touching sportnavi.de.

When the line is on the real site, walk through this once:

1. Open any page: the green button is in the bottom-right corner and sits above the page
   content, footer and cookie banner.
2. Click it: the greeting appears, then the privacy notice. Press **Zustimmen**.
3. Ask something like *"Was ist Firmenfitness?"* — an answer arrives within a few seconds.
4. Try **Partner finden** with *"Yoga in Bochum"* — this one takes **30 to 60 seconds**, that
   is normal; the dots keep moving while it searches.
5. Open the **Kontaktformular**, but only submit it if you want a real test case in Salesforce.
6. Check on a phone: the chat fills the screen and its own ✕ closes it.

### Privacy, in plain words

- Opening the chat window loads Navio from its server, like loading any web page. No message
  and no personal detail is sent until the visitor presses **Zustimmen** in the chat.
- The chat runs inside its own small window on Navio's address, not on sportnavi.de. The moment
  that window opens it stores, on that address only, a random visitor number used to protect
  against abuse; it also remembers the light/dark choice. It sets no cookies on sportnavi.de itself.
- Conversations are anonymous; the visitor is never asked to log in. The contact form is the
  only place personal details are entered, and those go to Salesforce as they do today.
- The privacy notice inside the chat links to the Sportnavi Datenschutzerklärung.

### If something does not look right

| What you see | What it usually means | What to do |
|---|---|---|
| No button at all | The line is not on this page, the address inside it has a typo, or the consent tool is holding the script back | Check the page source for the line; check the address; allow the script in the consent tool |
| Button appears, window is empty or white | This page's address is not on the allowed list yet | Ask the tech team to add the site (see above) |
| Button hides behind another element, or overlaps a "back to top" button | The site has its own fixed element in the same corner | Move the site's own element; Navio's button always sits bottom-right |
| Chat opens but a message shows "Origin not allowed" | Same cause as the empty window | Same fix |
| Answers stop coming or the chat says it is unavailable | Navio's server side, not the website | Tell the tech team; the website needs no change |
| Partner search seems stuck | It runs 30 to 60 seconds by design | Wait; if it passes a minute and a half, tell the tech team |

### Taking Navio off a site

Delete the line and it is gone with the next page load. Nothing else was added to the website,
so nothing else needs cleaning up. To pause Navio everywhere at once, the tech team can do it
on the server side without touching the website.

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

## Documentation

Everything is documented. Start with the row that matches what you want to do.

**🚀 Deploy & host**

| Doc | What it covers |
|---|---|
| ⭐ [VERCEL-DASHBOARD-GUIDE.md](kb-agent-langsmith-starter/docs/deployment/VERCEL-DASHBOARD-GUIDE.md) | **Canonical guide.** Full non-technical deploy + security walkthrough (§1 architecture → §8 launch checklist). **Start here to go live.** |
| [VERCEL-RUNBOOK.md](kb-agent-langsmith-starter/docs/deployment/VERCEL-RUNBOOK.md) | The same steps as copy-paste **Vercel CLI** commands. |
| [PUBLIC-WIDGET-DEPLOYMENT.md](kb-agent-langsmith-starter/docs/deployment/PUBLIC-WIDGET-DEPLOYMENT.md) | The deeper **"why"** behind the deployment + embedding workflow. |
| [Put Navio on the Sportnavi websites](#put-navio-on-the-sportnavi-websites--the-guide-for-the-website-team) | **Non-technical**, for the website team: the one line, where to paste it, which sites are allowed, testing, privacy, troubleshooting. |
| [09-website-security.md](docs/09-website-security.md) · [PRODUCTION-READINESS-REVIEW.md](kb-agent-langsmith-starter/docs/PRODUCTION-READINESS-REVIEW.md) | Security model, and the go-live readiness checklist. |

**🧭 Understand the product & architecture**

| Doc | What it covers |
|---|---|
| [docs/](docs/) ([index](docs/README.md)) | Numbered project docs **01–11**: objective, challenges, architecture, prompt engineering, experiments, KB strategy, team workflow, feedback loop, security, operations, roadmap. |
| [01-project-objective.md](docs/01-project-objective.md) · [03-solution-architecture.md](docs/03-solution-architecture.md) | Why Navio exists and how it's built. |
| [10-operations.md](docs/10-operations.md) | Setup, environment variables, testing, day-to-day operation. |
| [reference/NAVIO-plus.md](docs/reference/NAVIO-plus.md) · [reference/PROJECT_DOCUMENTATION.md](docs/reference/PROJECT_DOCUMENTATION.md) | Product overview and long-form project documentation. |

**🎨 Design & widget**

| Doc | What it covers |
|---|---|
| [WIDGET-DESIGN-GUIDELINES.md](kb-agent-langsmith-starter/docs/design/WIDGET-DESIGN-GUIDELINES.md) | The two-colour brand system (green = AI, orange = human), fonts, launcher. |
| [NAVIO_PLUS_WIDGET_SPEC.md](kb-agent-langsmith-starter/docs/design/NAVIO_PLUS_WIDGET_SPEC.md) · [NAVIO_WIDGET_SPEC.md](kb-agent-langsmith-starter/docs/design/NAVIO_WIDGET_SPEC.md) | The widget/menu specifications. |

**🤖 The Partner agent (Service 2)**

| Doc | What it covers |
|---|---|
| [PROJECT_CONTEXT.md](SportnaviPartnerRecomandationBot/PROJECT_CONTEXT.md) | The Partner agent's full operating manual — pipeline, data, invariants. |
| [AGENT_ONBOARDING.md](SportnaviPartnerRecomandationBot/AGENT_ONBOARDING.md) | Fast on-ramp for the Partner agent. |

**📊 Observability, evaluation & cost**

| Doc | What it covers |
|---|---|
| [DEV-CONSOLE-MONITORING.md](kb-agent-langsmith-starter/docs/DEV-CONSOLE-MONITORING.md) | What to watch after launch; LangSmith (EU) tracing. |
| [reference/EVE_LANGSMITH_TRACING_GUIDE.md](docs/reference/EVE_LANGSMITH_TRACING_GUIDE.md) | Deep OpenTelemetry → LangSmith tracing reference. |
| [reference/PERFORMANCE-COST-ANALYSIS.md](kb-agent-langsmith-starter/docs/reference/PERFORMANCE-COST-ANALYSIS.md) · [05-experiment-analysis.md](docs/05-experiment-analysis.md) | Cost/latency analysis and experiment results. |
| [kb-agent docs index](kb-agent-langsmith-starter/docs/README.md) | Index of all widget-service docs (deployment, design, decisions, reference). |

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

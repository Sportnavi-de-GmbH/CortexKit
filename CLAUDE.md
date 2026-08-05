# CLAUDE.md — CortexKit / Navio

Long-term project memory. Read this first: it should be enough to understand what the product
is, how the Navio menu works, how the two agents relate, and where the project stands —
without re-investigating.

**Last verified against source: 2026-08-04.**

> **Golden rule:** source (`agent/`, `lib/`, `app/`, `components/`) wins over prose, including
> this file. Older docs in this repo have been wrong before (see §10.5).

---

## 1. What this is

**Navio** is Sportnavi's public, anonymous, login-less chat widget for
[sportnavi.de](https://sportnavi.de) (a German corporate-fitness network). It is embedded on
the marketing site with **one `<script>` tag** and opens in an iframe.

One widget, **three capabilities**, behind one menu. Two of them are separate **eve** agents:

| | **FAQ Agent** | **Partner Agent** |
|---|---|---|
| Answers | "How does Sportnavi work?" — policies, tariffs, check-in, cashback, contracts | "Where can I train?" — real studios/courses near a city |
| Retrieval | **None.** KB baked into the system prompt | **RAG.** Supabase directory + embedding similarity |
| Tools | **0** (11 built-ins disabled) | **2** (`find_partners`, `get_partner_details`); 10 disabled |
| Data | 5 static FAQ documents | 2,333 partners across 649 cities (live DB) |
| Lives in | `kb-agent-langsmith-starter/` (this repo) | `SportnaviPartnerRecomandationBot/` (**separate repo**) |
| Reached via | `/eve/v1/*` (same-origin) | `/api/partner/*` → proxy → its own deployment |
| Typical latency | 2–8s | **30–60s** (DB search + long answer) |

**When to use which:** anything about *the product, rules, money, contracts* → FAQ Agent.
Anything about *finding a place to train* → Partner Agent. They do not share context or
sessions; the menu decides which one the user is talking to.

---

## 2. The Navio menu — structure and navigation

The widget is a screen state machine in
[`components/navio/NavioWidget.tsx`](kb-agent-langsmith-starter/components/navio/NavioWidget.tsx):

```ts
type Screen = "greeting" | "consent" | "menu" | "chat" | "partner" | "contact" | "info";
```

### User flow

```
sportnavi.de page
  └─ launcher.js  → floating button (ink circle, brand-green icon)
       └─ click → iframe opens /widget
            │
            ▼
   [greeting]   "Hi, ich bin Navio 👋🏻" + "Mit Navio chatten"
            │
            ▼
   [consent]    GDPR gate — Zustimmen / Ablehnen.
            │   ONE consent covers all three options. Decline ⇒ nothing proceeds.
            ▼
   [menu]  ── "Navio Plus" ───────────────────────────────────────────┐
            │                                                          │  ⓘ → [info]
            ├─ card 1 "FAQ-Agent"       → [chat]     FAQ Agent         │
            ├─ card 2 "Partner finden"  → [partner]  Partner Agent     │
            └─ card 3 "Kontaktformular" → [contact]  Salesforce form   │
                                                                       │
   Every sub-screen has a ← back arrow returning to [menu].
```

### The three menu cards

Defined in [`components/navio/NavioMenu.tsx`](kb-agent-langsmith-starter/components/navio/NavioMenu.tsx):

| # | Card title | Subtitle (DE) | Icon | Accent | Opens |
|---|---|---|---|---|---|
| 1 | **FAQ-Agent** | "Stell deine Frage – Navio antwortet sofort, rund um die Uhr." | `Bot` | green | `chat` |
| 2 | **Partner finden** | "Finde Studios & Kurse in deiner Nähe – sag einfach Stadt und Sportart." | `MapPin` | green | `partner` |
| 3 | **Kontaktformular** | "Schreib uns direkt – wir melden uns zeitnah bei dir zurück." | `Mail` | orange | `contact` |

**Colour rule (do not break):** the palette is deliberately two-colour —
`--brand-green` `#95c11e` is the single call-to-action / AI-chat colour, `--brand-orange`
`#ec6607` means *human hand-off*. Both chat cards are green; only the contact card is orange.
Never add a third brand colour. (`docs/design/WIDGET-DESIGN-GUIDELINES.md`)

### Header titles per screen

The header label differs from the card label — don't "fix" this, it's intentional:

| Screen | Header title | Subtitle |
|---|---|---|
| `consent`, `menu` | **Navio Plus** | Online |
| `chat` | **FAQ-Agent** | Online |
| `partner` | **Partner-Finder** | Online |
| `contact` | **Kontakt aufnehmen** | Antwort in 1–2 Werktagen |
| `info` | **Über Navio Plus** | — |

### Per-screen chat copy

`chat` and `partner` share `ChatBody` / `InputBar`, parameterised by `CHAT_CFG`:

| | `chat` (FAQ) | `partner` |
|---|---|---|
| Greeting | "Hi, ich bin Navio 👋🏻 / Dein Guide durch die Sportnavi Welt…" | "Sag mir, wo und was du trainieren willst – z. B. 'Yoga in Bochum' 📍" |
| Quick replies | Angebote finden · Wie checke ich ein? · Partner werden · Sportnavi für Firmen | Yoga in Bochum · Klettern für Anfänger · Fitnessstudio in Bielefeld · Reha-Sport in meiner Nähe |
| Placeholder | "Frage Navio …" | "Stadt & Sportart, z. B. 'Yoga in Bochum' …" |

Header actions: ↺ reset (chat screens only), ⓘ info (menu only), 🌙/☀️ theme (consent/menu),
✕ close (always — posts `snv-widget-close` to the parent page).

---

## 3. Architecture

### Runtime topology

```
                     sportnavi.de
                          │  <script src="https://chat.sportnavi.de/launcher.js" async>
                          ▼
   ┌──────────────────────────────────────────────────────────┐
   │ SERVICE 1 — Navio widget   (kb-agent-langsmith-starter)  │  public, browser-facing
   │                                                          │
   │  /widget           iframe UI + menu                      │
   │  /launcher.js      embed script                          │
   │  /eve/v1/*         FAQ Agent  (no tools, KB in prompt)   │
   │  /api/contact      Salesforce Case (server-only creds)   │
   │  /api/partner/* ──┐ same-origin proxy                    │
   └───────────────────┼──────────────────────────────────────┘
                       │ PARTNER_AGENT_HOST
                       ▼
   ┌──────────────────────────────────────────────────────────┐
   │ SERVICE 2 — Partner Agent  (separate repo + deploy)      │  never called by the browser
   │  /eve/v1/*   find_partners → Supabase + embeddings       │
   └──────────────────────────────────────────────────────────┘
```

**Why a proxy and not a direct call:** the browser only ever talks to **one origin**, so the
consent gate, origin allowlist, BotID and Firewall rules are reused, and there is **no CORS**.
The two repos stay independently deployable.

### Request flows

**FAQ turn** — one model call, no tools:
```
user msg → channel auth (size cap → BotID → origin) → eve agent
         → Azure gpt-4.1 with the ~16.7k-token prompt as `instructions` → stream
         → OTLP spans + hook runs → LangSmith EU
```

**Partner turn** — two model steps:
```
user msg → /api/partner/eve/v1/* (proxy) → partner agent
   step 1: model calls find_partners({cityMention, intentText, tags})
           → resolve city (fuzzy RPC) → all home-city partners
           → gap-fill from nearby cities by embedding similarity (disclosed)
           → rank → hydrate top N profiles → render
   step 2: model writes the German prose answer from that result only
```
A search is **2 model steps**. Non-search turns (greeting, "which city?") are **1**.
4 steps means an old tool chain regressed.

**Contact submit:** browser → `POST /api/contact` → zod validate → Salesforce OAuth + flow →
Case. Credentials never reach the client. Blank credentials ⇒ simulate mode.

### Dual agent clients in one widget

[`app/widget/page.tsx`](kb-agent-langsmith-starter/app/widget/page.tsx):

```ts
const faqAgent     = useEveAgent();                          // same-origin
const partnerAgent = useEveAgent({ host: "/api/partner" });  // via the proxy
return <NavioWidget faqAgent={faqAgent} partnerAgent={partnerAgent} />;
```

`useEveAgent` is **lazy** — no session until the first `send()` — so mounting both is free and
the widget still works when no partner host is configured. `NavioWidget` picks `activeAgent`
from the current screen. The two conversations are independent and both survive menu
navigation.

---

## 4. Repository layout

```
CortexKit/                                   ← this repo (github.com/AiLabSportnavi/CortexKit)
├── CLAUDE.md                                ← this file
├── ONBOARDING.md                            ← fast on-ramp for a new agent/developer
├── docs/                                    ← 01–11 long-form docs + reference/
├── .mcp.json                                ← langsmith (EU) + stitch MCP servers ⚠️ see §10
├── kb-agent-langsmith-starter/              ← SERVICE 1 (the deployable Vercel project)
│   ├── CLAUDE.md                            ← service-1 detail (deeper than this file)
│   ├── agent/
│   │   ├── agent.ts                         ← model + session token limits
│   │   ├── instructions.md                  ← THE FAQ system prompt (~16.7k tokens)
│   │   ├── channels/eve.ts                  ← public API auth: size cap → BotID → origin
│   │   ├── tools/*.ts                       ← 11 disableTool() sentinels
│   │   ├── instrumentation.ts, hooks/langsmith.ts   ← LangSmith EU
│   │   └── kb/kb.md                         ← reference copy of the KB (NOT live)
│   ├── app/
│   │   ├── widget/page.tsx                  ← the embeddable widget (mounts both agents)
│   │   ├── api/partner/[...path]/route.ts   ← proxy to service 2
│   │   └── api/contact/route.ts             ← Salesforce contact endpoint
│   ├── components/navio/                    ← NavioWidget, NavioMenu, KontaktForm
│   ├── lib/
│   │   ├── partner-proxy.ts                 ← proxy logic (SSRF guard, keep-alive)
│   │   ├── langsmith.ts, llm.ts, contact/, eval/
│   ├── public/launcher.js                   ← the one-line embed script
│   ├── docs/deployment/                     ← the three deployment guides
│   ├── evals/datasets/*.json                ← eval datasets (repo is source of truth)
│   └── tests/                               ← vitest
└── SportnaviPartnerRecomandationBot/        ← SERVICE 2 — SEPARATE GIT REPO, untracked here
    └── partner-recommendation-agent/
        ├── agent/agent.ts, instructions.md, tools/, config/partner-injection.config.ts
        └── lib/partners/                    ← deterministic pipeline (no LLM math)
```

**Never `git add` `SportnaviPartnerRecomandationBot/` from this repo** — it has its own remote
(`AiLabSportnavi/SportnaviPartnerRecomandationBot`) and its own history. Commit inside it.

When searching, exclude `.eve/`, `.next/`, `.output/`, `node_modules/` — they contain
duplicate dev-host snapshots of the source.

---

## 5. The two agents in detail

### 5.1 FAQ Agent — "the prompt is the product"

- **Zero tools by design.** eve ships built-ins unless each is disabled, so `agent/tools/`
  holds 11 `disableTool()` sentinels. Disabling `web_search` is deliberate: it would give the
  model a source of truth outside the curated KB.
- **KB is embedded**, not retrieved — five FAQ documents between the
  `=== KNOWLEDGE BASE ===` and `=== BEHAVIOR RULES ===` markers of `agent/instructions.md`.
- **To change behaviour, edit `agent/instructions.md`.** No code change needed.
  `agent/kb/kb.md` is a reference copy — editing it does nothing.
- **Prompt size ~16.7k tokens** (measure with `npm run cache:check`). Earlier docs said
  "41.5k"/"71 KB" — wrong.
- **Session budgets** in `agent.ts`: 250k input / 20k output per session (env-tunable via
  `NAVIO_MAX_*`). eve's defaults (40M / uncapped) are far too loose for a public endpoint.

### 5.2 Partner Agent — deterministic pipeline, model only phrases

Its own repo and its own `CLAUDE.md` / `PROJECT_CONTEXT.md` / `AGENT_ONBOARDING.md` are
authoritative. What matters here:

- **The LLM never counts, ranks, dedupes or retrieves.** That is `lib/partners/`
  (resolve → gap-fill → rank → hydrate). The model only writes prose from the result.
- **Honesty invariant:** it never invents a partner, price, opening hour or service. Every
  named business must come from a `find_partners` result *in that conversation*.
- **Partner-injection algorithm:** use the requested city *whole*, then borrow the shortfall
  from nearby cities by embedding similarity — **disclosing every borrow**. The directory is
  uneven (median city has 1 partner; only Bielefeld has ≥100), which is why this exists.
- **Tuning lives in one file**, `agent/config/partner-injection.config.ts`
  (**retuned 2026-08-04**):

  | Dial | Value | Meaning |
  |---|---|---|
  | `minPartners` / `maxPartners` | **40** | gap-fill target / hard ceiling of candidates resolved |
  | `finalRecommendations` | **5** | how many the user actually sees (top-ranked, full profiles) |
  | `maxCities` | 8 | home + nearby cities drawn from |
  | `similarityThreshold` | 0.2 | min cosine similarity to accept a borrowed partner |
  | `maxDistanceKm` | 120 | borrow radius |
  | `dedupHeadroom` | 20 | extra candidates fetched to survive filtering |

  Presets: `PRODUCTION` (= default), `WIDE_CONTEXT` (60), `BALANCED` (30), `STRICT_CITY`
  (5, gap-fill disabled). **Intent: resolve ~40 candidates, curate down to 5 shown.** This
  replaced an earlier 100/100 profile that broke the agent — see §10.1.
- **Contact details are public directory data** and belong in answers; `email`/`phone` reach
  the model through exactly one path (the pre-rendered `llm_profile`). Don't add them to
  `PartnerLite`.

---

## 6. Configuration

### Service 1 (widget) — `.env.local` / Vercel env

| Variable | Required | Notes |
|---|---|---|
| `AZURE_AI_CHATBOT_OPENAI_ENDPOINT` / `_API_KEY` / `_DEPLOYMENT_NAME` | ✅ | FAQ model (default `gpt-4.1`) |
| **`PARTNER_AGENT_HOST`** | for card 2 | Service 2's URL. **Unset ⇒ "Partner finden" returns 503**, rest of widget fine. Locally use `http://127.0.0.1:3001` — **not** `localhost` (Node `fetch` may pick IPv6 and fail). |
| `WIDGET_FRAME_ANCESTORS` | recommended | who may **embed** the iframe (CSP on `/widget`) |
| `WIDGET_ALLOWED_ORIGINS` | only if cross-origin | extra origins allowed to call the API |
| `NAVIO_MAX_REQUEST_BYTES` | optional | body cap, default 16 KB |
| `NAVIO_MAX_INPUT_TOKENS_PER_SESSION` / `_OUTPUT_` | optional | session budgets |
| `AI_GATEWAY_MODEL` | recommended | routes via Vercel AI Gateway ⇒ hard spend cap |
| `BOTID_ENABLED` + `NEXT_PUBLIC_BOTID_ENABLED` | later | must match |
| `LANGSMITH_*` | optional | EU only; keep `LANGSMITH_RECORD_IO=false` |
| `SALESFORCE_*`, `CONTACT_RATE_LIMIT_PER_MIN`, `MAX_MESSAGE_CHARS` | contact form | blank creds ⇒ simulate mode |

### Service 2 (partner agent)
`AZURE_AI_CHATBOT_*`, `MEMORY_SUPABASE_URL`, `MEMORY_SUPABASE_SERVICE_ROLE_KEY`
(**service-role required** — RLS on with no policies; the anon key silently returns zero rows),
`EMBEDDING_API_URL`, `EMBEDDING_API_KEY`, optional `SENTRY_*` / `LANGSMITH_*`.

---

## 7. Development workflow

```powershell
# terminal 1 — Partner Agent (separate repo)
cd SportnaviPartnerRecomandationBot\partner-recommendation-agent
npm install; npm run dev:ui -- -p 3001

# terminal 2 — Navio widget
cd kb-agent-langsmith-starter
npm install; npm run dev:ui -- -p 3010     # .env.local: PARTNER_AGENT_HOST=http://127.0.0.1:3001
```

Open **`http://localhost:3010/widget`**. (Port 3000 is often occupied; the widget's own port
doesn't matter — only `PARTNER_AGENT_HOST` must point at the partner agent.)

| Command | Purpose |
|---|---|
| `npm run dev:ui` | Next console + widget (normal way to run) |
| `npm run dev` | eve backend only |
| `npm run typecheck` / `npm test` | must be green before committing |
| `npx eve info` | lists the agent; confirms disabled tools |
| `npm run cache:check` | measures prompt size + Azure prompt-cache hit |
| `npm run eval:upload` / `eval:run` | dataset upload / two-phase eval |

**Windows:** `src/internal/authored-module-map-loader.ts` is a required eve 0.25.x dev-host
shim (without it `POST /eve/v1/session` → `ERR_MODULE_NOT_FOUND`), and `lib/load-env.ts` must
be imported **first** in every entry point.

**Run one partner instance.** Multiple copies share the same Azure TPM quota.

---

## 8. Deployment

**Status: nothing is deployed yet.** No `vercel.json` and no `.vercel/` link exists in either
repo. The guides describe the intended setup:

- [`docs/deployment/PUBLIC-WIDGET-DEPLOYMENT.md`](kb-agent-langsmith-starter/docs/deployment/PUBLIC-WIDGET-DEPLOYMENT.md)
  — architecture, env matrix, Firewall, spend cap, **complete embedding workflow (§9)**
- [`docs/deployment/VERCEL-RUNBOOK.md`](kb-agent-langsmith-starter/docs/deployment/VERCEL-RUNBOOK.md) — CLI
- [`docs/deployment/VERCEL-DASHBOARD-GUIDE.md`](kb-agent-langsmith-starter/docs/deployment/VERCEL-DASHBOARD-GUIDE.md) — no terminal

**Two Vercel projects, partner agent deployed first:**

| # | Project | Repo | **Root Directory** (mandatory) |
|---|---|---|---|
| 1 | navio-widget (public) | `AiLabSportnavi/CortexKit` | `kb-agent-langsmith-starter` |
| 2 | navio-partner (internal) | `AiLabSportnavi/SportnaviPartnerRecomandationBot` | `partner-recommendation-agent` |

Skipping Root Directory makes every URL 404. After service 2 has a URL, set service 1's
`PARTNER_AGENT_HOST` to it and redeploy (env changes need a redeploy).

**Embedding is one line**, ideally in the site's global template:

```html
<script src="https://chat.sportnavi.de/launcher.js" async></script>
```

`launcher.js` derives its own origin from its `src`, so the same tag works on production,
previews and localhost with no edits. It injects the floating button, opens
`<same-origin>/widget` in an iframe, and closes on a `snv-widget-close` postMessage. Who may
embed is controlled by `WIDGET_FRAME_ANCESTORS` (CSP `frame-ancestors` on `/widget`); to allow
another site, add its origin there **and** to Firewall Rule A.

**Security layers** (defense in depth, none sufficient alone): request-size cap → BotID →
origin allowlist (`agent/channels/eve.ts`) · Vercel Firewall origin + rate-limit rules ·
`frame-ancestors` · Azure TPM limit and/or AI-Gateway hard spend cap.

---

## 9. Implementation details worth remembering

- **Prompt caching is the dominant cost lever.** The ~16.7k FAQ prompt replays every turn; a
  byte-identical prefix earns a large Azure discount. **Never interpolate per-request data
  into the system prompt** — put it in `runtimeContext`.
- **LangSmith invariants:** EU endpoint everywhere · **no key ⇒ no-op** (a fresh clone runs
  credential-free) · **hooks never throw** (eve reports failures as stream events, never
  exceptions) · content capture off unless `LANGSMITH_RECORD_IO=true` · one request = one
  trace via deterministic OTLP span-id → run-id mapping.
- **Eval pipeline is two-phase** (`scripts/run-eval.ts`): execute serially with pacing, then
  evaluate — so rate-limit waits never pollute trace latency. TPM is the binding constraint.
- **Contact form:** server-only Salesforce creds, `Idempotency-Key` guard, `maxDuration = 30`,
  and **PII-safe logging** (`safeShape()` logs field names + sizes, never values). Its in-code
  rate limiter is **per serverless instance** — the real control is a Firewall rule.
- **Proxy must keep doing three things** (`lib/partner-proxy.ts`): only forward `eve/*` paths
  (SSRF guard); strip `content-encoding`/`content-length` from responses (Node `fetch` already
  decompressed the body); inject an SSE keep-alive comment every 15s plus `no-transform` /
  `X-Accel-Buffering: no`.

---

## 10. Hard-won lessons (do not re-learn these)

1. **A partner search failed on *size*, not request frequency.** With `maxPartners: 100`, a
   dense city (Bochum: 30 home + 70 borrowed) rendered ~100 profiles ≈ 42k tokens into one
   tool result, making the next model call ~60–78k tokens — **larger than the Azure
   deployment's whole per-minute allowance**. It returned 429 on *every* attempt at any
   spacing. Sparse cities (Hamburg, 36 partners) stayed small and worked, which made it look
   intermittent. Fixed by retuning the config (now 40 candidates → 5 shown). **Keep Azure TPM
   and `maxPartners`/`finalRecommendations` consistent.**
2. **`ask_question` produces no assistant message.** A missing-city query made the partner
   model call eve's built-in `ask_question`, which emits an `input.requested` event and ends
   the turn with **zero** `message.appended` — the dev console renders that, the widget does
   not, so the user saw an empty bubble forever. Fixed by adding an `ask_question`
   `disableTool()` sentinel in service 2; clarification now streams as normal prose (and its
   documented "exactly two tools" budget is restored).
3. **Long silent SSE streams die in browsers, not in curl.** A partner search emits nothing
   for 30–60s; browsers drop the idle connection and report `network error`. Hence the proxy
   keep-alive. **Never debug a streaming problem with curl alone.**
4. **The cheapest agent hallucinates.** In service 2's history, a "cost optimization" once
   looked like a −58% win because the model had stopped calling the database and was inventing
   studios. Every efficiency change must be paired with a work-actually-performed metric
   (e.g. "was `find_partners` called at all") and the evals.
5. **Don't trust doc figures over code.** "41.5k tokens", "10 built-in tools", "gpt-4o",
   "no wiring exists between the projects" were all wrong in earlier versions of this file.

---

## 11. Open items, limitations, next steps

**Highest priority (blockers for a public launch)**
1. **Deploy both services** and wire `PARTNER_AGENT_HOST` (§8). Nothing is live yet.
2. **Lock down service 2.** The proxy forwards with **no shared secret**, so a deployed
   partner agent would be openly reachable. Add a Firewall rule / shared-secret header /
   Deployment Protection.
3. **Rotate the keys committed in `.mcp.json`** (LangSmith + Stitch) and move them to env.
4. **Distributed rate limiting** via Vercel Firewall for `/eve/v1/*`, `/api/partner/*`,
   `/api/contact` — the in-code limiters are per-instance.
5. **AI Gateway spend cap** (`AI_GATEWAY_MODEL`) or an Azure TPM ceiling sized to a
   worst-case partner turn.

**Known limitations / UX**
- **No progress indicator during a partner search.** The bubble is empty for 30–60s and reads
  as a hang. `ChatBody` shows typing dots only while `status === "submitted"`; keep them
  visible while streaming-with-no-text (ideally "Suche passende Partner …"). **Most visible
  remaining rough edge.**
- **Contact form has no email fallback** — a Salesforce outage loses the lead (payload *shape*
  is logged, values are not). `nodemailer` + `SMTP_*` not wired.
- **No streaming-route timeout** on the eve stream (contact route has `maxDuration = 30`).

**Quality / cost backlog**
- **Prompt V3 written but not deployed** (`agent/feedback/SYSTEM_PROMPT_V3.md`, 646 lines vs
  the live 1,384). Deploy = replace `instructions.md`, then re-run evals.
- **9 known KB factual errors** documented in `agent/feedback/FEEDBACK-ANALYSIS.md`.
- **Model right-sizing** — evaluate `gpt-4.1-mini` for the FAQ agent against the eval set.
- Full checklist: [`docs/PRODUCTION-READINESS-REVIEW.md`](kb-agent-langsmith-starter/docs/PRODUCTION-READINESS-REVIEW.md).

---

## 12. Conventions

- **Behaviour changes go through the prompt**, not code: `agent/instructions.md` (FAQ) or
  service 2's `instructions.md`. Validate with the eval loop; never bypass the feedback
  history in `agent/feedback/`.
- **Keep the FAQ agent tool-free** and service 2 at **two** tools. Every advertised tool costs
  schema tokens on every model call.
- **Widget visuals** follow `docs/design/WIDGET-DESIGN-GUIDELINES.md` — green = AI action,
  orange = human hand-off, Outfit + Inter.
- **Never commit `.env.local` or a real key.** Never point LangSmith at the US endpoint.
- **Two repos, two histories.** Commit service-2 changes inside its own repo.
- Start feature work with `superpowers:brainstorming`; start bugs with
  `superpowers:systematic-debugging`.

**Capabilities available:** LangSmith MCP (EU) for traces/datasets/experiments ·
`langsmith-trace` / `langsmith-dataset` / `langsmith-evaluator` skills · `context7` (dependency
docs) · `playwright` / `browse` (drive the widget in a real browser — the only way to catch
UI-only bugs like #10.3).

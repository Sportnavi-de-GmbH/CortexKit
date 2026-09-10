# Deploying Navio as a Public Widget on sportnavi.de

Hand-off guide for the internal dev team: the **architecture**, the **Vercel-account steps**
that can't live in code (domains, Firewall, BotID, spend cap), the **complete embedding
workflow**, and how to **verify** it.

Companions: [`VERCEL-RUNBOOK.md`](VERCEL-RUNBOOK.md) (CLI, copy-paste) ·
[`VERCEL-DASHBOARD-GUIDE.md`](VERCEL-DASHBOARD-GUIDE.md) (click-by-click, no terminal).

> ℹ️ **[`VERCEL-DASHBOARD-GUIDE.md`](VERCEL-DASHBOARD-GUIDE.md) is the canonical, step-by-step
> source for the firewall rules and security configuration** (including the shared-secret Partner
> lock that is now implemented in code). This file gives the architecture and rationale behind
> those steps; where the two overlap, follow the dashboard guide's exact settings.

> **Status (2026-08-03):** the widget, the 3-option menu, the contact form, and the Partner
> Agent integration are **built and verified locally**. No `vercel.json` or `.vercel/` link
> exists in either repo, so treat every Vercel step below as **not yet done** unless your
> dashboard says otherwise.

---

## 1. What you are deploying — TWO services

Since the Partner Agent was added, Navio is **two independently deployed apps**:

```
                    sportnavi.de (marketing site)
                              │  <script src=".../launcher.js">
                              ▼
        ┌─────────────────────────────────────────────┐
        │  SERVICE 1 — Navio widget  (this repo)      │   ← public, browser-facing
        │  kb-agent-langsmith-starter/                │
        │                                             │
        │  /widget            the iframe UI + menu    │
        │  /launcher.js       the embed script        │
        │  /eve/v1/*          the KB (FAQ) agent      │
        │  /api/contact       Salesforce contact form │
        │  /api/partner/*  ───┐  same-origin proxy    │
        └─────────────────────┼───────────────────────┘
                              │  PARTNER_AGENT_HOST
                              ▼
        ┌─────────────────────────────────────────────┐
        │  SERVICE 2 — Partner Agent                  │   ← never called by the browser
        │  SportnaviPartnerRecomandationBot/          │
        │  partner-recommendation-agent/              │
        │  /eve/v1/*   partner search (Supabase RAG)  │
        └─────────────────────────────────────────────┘
```

**Why a proxy instead of calling service 2 directly:** the browser only ever talks to
**one origin** (service 1). That reuses the existing consent gate, origin allowlist, BotID
and Firewall rules, and needs no CORS. Service 2 can stay locked down — see §6.

**One repo, two Vercel projects** (told apart by Root Directory — both app folders live inside
`CortexKit`):

| Service | Repo | Vercel root directory |
|---|---|---|
| 1 — Navio widget | `CortexKit` | **`kb-agent-langsmith-starter`** |
| 2 — Partner Agent | `CortexKit` (same repo) | **`SportnaviPartnerRecomandationBot/partner-recommendation-agent`** |

⚠️ Setting **Root Directory** is mandatory for both. If you skip it (or pick the wrong folder),
Vercel builds the wrong part of the repo and every URL 404s.

> ℹ️ The standalone `SportnaviPartnerRecomandationBot` GitHub repo exists but is **out of date and
> unused** — the partner agent's current code is the folder inside `CortexKit`. Deploy both
> projects from `CortexKit`.

---

## 2. What's already in the code (nothing to build)

**Service 1 — widget:**
- `components/navio/NavioWidget.tsx` — screen flow: greeting → consent → **menu** →
  {FAQ chat | Partner chat | Kontaktformular | info}.
- `components/navio/NavioMenu.tsx` — the **three** menu cards.
- `app/widget/page.tsx` — mounts **two** eve clients: the KB agent (same-origin) and the
  partner agent (`useEveAgent({ host: "/api/partner" })`).
- `app/api/partner/[...path]/route.ts` + `lib/partner-proxy.ts` — the proxy (SSRF guard,
  503 when unconfigured, SSE keep-alive).
- `app/api/contact/route.ts` + `lib/contact/` — Salesforce contact form (server-only creds).
- `agent/channels/eve.ts` — anonymous-but-origin-checked auth, BotID gate, 16 KB body cap.
- `agent/agent.ts` — per-session token limits; routes via AI Gateway when `AI_GATEWAY_MODEL` is set.
- `next.config.mjs` — `frame-ancestors` (who may embed) + hardening headers.
- `public/launcher.js` — the one-line embed script.

**Service 2 — partner agent:** its own eve app; see that repo's `CLAUDE.md`.

---

## 3. Environment variables

### Service 1 (Navio widget)

| Variable | Required | Notes |
|---|---|---|
| `AZURE_AI_CHATBOT_OPENAI_ENDPOINT` | ✅ | KB agent model |
| `AZURE_AI_CHATBOT_API_KEY` | ✅ | |
| `AZURE_AI_CHATBOT_DEPLOYMENT_NAME` | ✅ | e.g. `gpt-4.1` |
| **`PARTNER_AGENT_HOST`** | ⬅ **new** | Service 2's URL, e.g. `https://partner.sportnavi.de`. **Unset ⇒ the "Partner finden" option returns 503** and the rest of the widget still works. |
| `WIDGET_FRAME_ANCESTORS` | recommended | who may embed the iframe (default already allows sportnavi.de) |
| `WIDGET_ALLOWED_ORIGINS` | only if cross-origin | extra browser origins allowed to call the API |
| `BOTID_ENABLED` / `NEXT_PUBLIC_BOTID_ENABLED` | later | must match each other |
| `AI_GATEWAY_MODEL` | recommended | activates the hard spend cap |
| `LANGSMITH_*` | optional | EU endpoint; keep `LANGSMITH_RECORD_IO=false` |
| `SALESFORCE_*` | for contact form | blank ⇒ simulate mode (no Case created) |
| `NAVIO_MAX_INPUT_TOKENS_PER_SESSION` / `..._OUTPUT_...` / `NAVIO_MAX_REQUEST_BYTES` | optional | session/abuse budgets; sane defaults in code |

### Service 2 (Partner Agent)
`AZURE_AI_CHATBOT_*`, `MEMORY_SUPABASE_URL`, `MEMORY_SUPABASE_SERVICE_ROLE_KEY` (service-role
is mandatory — RLS is on with no policies), `EMBEDDING_API_URL`, `EMBEDDING_API_KEY`, plus
optional `SENTRY_*` / `LANGSMITH_*`. See `.env.local.example` in that repo.

---

## 4. Deploy order

1. **Deploy service 2 first** (it has no dependency on service 1). Note its production URL.
2. **Deploy service 1**, setting `PARTNER_AGENT_HOST` to that URL.
3. Add the custom domain(s) — e.g. `chat.sportnavi.de` for service 1.
4. Redeploy service 1 after any env change (env is read at build/runtime, not hot-reloaded).

Detailed steps: [`VERCEL-RUNBOOK.md`](VERCEL-RUNBOOK.md) (CLI) or
[`VERCEL-DASHBOARD-GUIDE.md`](VERCEL-DASHBOARD-GUIDE.md) (dashboard).

---

## 5. Vercel Firewall — origin allowlist + rate limits

On **service 1**. Vercel → **Firewall → Custom Rules**. **Stage every rule as `Log` first**,
review real traffic under Firewall → Traffic, then switch to enforcing.

**Rule A — Origin allowlist.** Path starts with `/eve/v1/` **AND** header `Origin` *exists*
**AND** `Origin` is not one of `https://navio-widget.vercel.app`, `https://chat.sportnavi.de`,
`https://www.sportnavi.de`, `https://sportnavi.de` **AND** environment is `production` → **Deny**.
The widget's own host MUST be in that list — the iframe's requests carry the widget host as
`Origin`, not `sportnavi.de` — and the environment clause keeps preview URLs working. Since
2026-09-10 the list also names a developer's own machine (`http://localhost` and
`http://127.0.0.1` on 3000/3001/5173/8080) so a local test page can call the API directly;
browsers cannot fake `Origin`, so this admits only pages really served on that machine, the
same loopback allowance the app gate already grants. Whether a localhost page may *embed* the
widget is a different control, `WIDGET_FRAME_ANCESTORS` (production: 3001 + 8080). A ready test
page is `embed-test/simple.html` (`node embed-test/serve.js`, then localhost:8080).
The *"Origin exists"* clause is deliberate: same-origin GET streams and health checks omit
`Origin`, and denying those would break streaming.

**Rule B — Rate limit session creation.** `POST /eve/v1/session`, keys IP + JA4, 60s window.
Start generous (20/min) on **Log**, then ~5–10× real peak on **429**.

**Rule C — Rate limit follow-up messages.** `POST /eve/v1/session/` — higher limit than B.

**Rule D — Light limit on the stream.** `GET` with path starting `/eve/v1/session/` OR
`/api/partner/eve/v1/session/` — generous (reconnects are normal). It was first created as a
bare `GET` rule that also counted every page file; narrowed 2026-09-10.

**Rule E — the partner proxy.** `/api/partner/` (every partner turn goes through it). Live at
15/min per IP; the dashboard guide's original 60/min is the figure to reconsider before
enforcing, since one search is several requests over 30–60 s.

**Rule F — the forms (added 2026-09-10).** `/api/contact` and `/api/feedback`, 15/min per IP.
The in-code limiters are per-instance and therefore *not* authoritative on serverless — this
Firewall rule is the real control.

**Live state 2026-09-10:** all six rules are published in **Log** mode (rate limits with
"exceeded → log"), i.e. nothing is enforced yet. Flip to Deny / 429 only after the Traffic review.

> DDoS mitigation is automatic on every deployment and blocked traffic isn't billed.
> Rate-limit counters are **per region**, so treat them as shaping; the true cost ceiling is
> the spend cap (§7).

---

## 6. Locking down service 2

The browser never calls service 2 — only service 1's server does. So don't leave it open:

- Give it a **separate domain** (e.g. `partner.sportnavi.de`) and don't publish it.
- Add a Firewall rule allowing `/eve/v1/` only from service 1's egress, or require a shared
  secret header, or use Vercel **Deployment Protection** with a bypass token that service 1
  sends. (The proxy forwards request headers, so a shared-secret header is the simplest.)
- At minimum, apply the same rate limits as §5.

⚠️ **Not implemented yet** — today the proxy forwards to `PARTNER_AGENT_HOST` with no
added credential. Track this before going public.

---

## 7. Spend cap — the real cost ceiling

Both services call Azure OpenAI, so cap **both**.

**Option A (works on any plan):** in the **Azure Portal** → your OpenAI resource → Model
deployments → `gpt-4.1` → **Edit** → set a **Tokens-Per-Minute (TPM)** limit, and add a
**Cost Management → Budget** with email alerts.

⚠️ **Sizing matters, learned the hard way (2026-08-03):** the partner agent injects one
profile block per partner into a single model call. At `maxPartners: 100` a dense city
(Bochum) produced a ~42k-token tool result and a ~60–78k-token model call — **larger than the
deployment's whole per-minute allowance**, so it returned 429 on *every* attempt regardless of
spacing. `maxPartners` is now **40**. If you lower Azure TPM, re-check that a worst-case
search still fits, or lower `maxPartners` to match.

**Option B (Pro / multi-app):** Vercel **AI Gateway** — add Azure OpenAI (EU) as a **BYOK**
provider, set a hard budget (past it the gateway returns `402` and stops spending), then set
`AI_GATEWAY_MODEL` and redeploy. On Vercel, gateway auth is automatic via OIDC.

---

## 8. BotID — invisible bot detection

1. `botid` is installed; server gate (`agent/channels/eve.ts`) and client init
   (`app/widget/page.tsx`) are wired and env-gated off.
2. Enable the challenge rewrites — wrap the export in `next.config.mjs`:
   `export default withBotId(withEve(nextConfig));` (import from `botid/next/config`). Left
   out of the committed config so the `withBotId`+`withEve` composition is validated on a real
   Vercel build first.
3. Enable **Deep Analysis** for the project (**Pro**; Hobby gets Basic only).
4. Set **both** `BOTID_ENABLED` and `NEXT_PUBLIC_BOTID_ENABLED` to `true` — they must match.
5. The widget is same-origin with the API, so no `extraAllowedHosts` and nothing to add on
   sportnavi.de.

---

## 9. Embedding the widget on the website — complete workflow

### 9.1 The one line

Once service 1 is deployed and reachable at its domain, the marketing team adds **one tag**
to any page (ideally the global layout/footer template so it appears site-wide):

```html
<script src="https://chat.sportnavi.de/launcher.js" async></script>
```

Nothing else. No build step, no npm package, no framework requirement — it works on plain
HTML, WordPress/TYPO3, React, Vue, Angular.

### 9.2 What that script actually does

`public/launcher.js` is dependency-free and:

1. **Derives its own origin** from its `src` (`document.currentScript`). The same file
   therefore works on `chat.sportnavi.de`, a `*.vercel.app` preview, or `localhost` **with no
   edits** — never hardcode the host.
2. Injects the floating launcher button (ink background, brand-green icon).
3. On click, opens an **iframe** pointing at `<same-origin>/widget`.
4. Listens for a `postMessage` of `"snv-widget-close"` from the iframe to close the panel
   (the widget's ✕ button sends it).
5. Guards against double-mounting (`window.__navioLauncherMounted`).

Because the iframe is served by the **same deployment** as the script, every call the widget
makes (`/eve/v1/*`, `/api/partner/*`, `/api/contact`) is **same-origin** — no CORS anywhere.

### 9.3 Required configuration for embedding

| What | Where | Why |
|---|---|---|
| `WIDGET_FRAME_ANCESTORS` | service 1 env | **Who may embed the iframe.** Space-separated origins; enforced by the browser via `Content-Security-Policy: frame-ancestors` on `/widget` (set in `next.config.mjs`). Default: `'self' https://www.sportnavi.de https://sportnavi.de`. A site not listed **cannot display the widget**. |
| `WIDGET_ALLOWED_ORIGINS` | service 1 env | Only if you serve the widget **cross-origin**. Normally leave blank — the iframe is same-origin. |
| Firewall Rule A | Vercel dashboard | Blocks other sites' browser code from calling the API. |
| `PARTNER_AGENT_HOST` | service 1 env | Makes the "Partner finden" menu option work. |

### 9.4 End-to-end embedding checklist

1. Deploy **service 2**; note its URL.
2. Deploy **service 1** with `PARTNER_AGENT_HOST` = that URL + the Azure vars.
3. Add domain `chat.sportnavi.de` to service 1; verify DNS (CNAME).
4. Set `WIDGET_FRAME_ANCESTORS` to include every site that should display the widget; redeploy.
5. Open `https://chat.sportnavi.de/widget` directly — the widget loads and answers.
6. Give the marketing team the `<script>` tag from §9.1.
7. On sportnavi.de, confirm the launcher button appears and the panel opens.
8. Confirm the widget is **refused** in an iframe on a non-allow-listed test page.
9. Flip Firewall Rule A from Log → Deny (see the preview-URL caveat in the dashboard guide).

### 9.5 Adding another site later

Append its origin to `WIDGET_FRAME_ANCESTORS` **and** to Firewall Rule A's allowlist, then
redeploy. No code change.

---

## 10. Verify before flipping rules to enforce

- **Health:** `GET /eve/v1/health` → 200 unauthenticated.
- **FAQ chat:** answers a KB question from the menu.
- **Partner chat:** "Yoga in Bochum" returns real partners **through `/api/partner/*`**
  (allow 30–60s — see §11).
- **Partner off-switch:** unset `PARTNER_AGENT_HOST` → that option 503s, the rest still works.
- **Contact form:** submits (or logs in simulate mode) and creates a Salesforce Case.
- **Origin lock:** `fetch()` to `/eve/v1/session` from a non-Sportnavi page is denied; the
  same call inside the widget works.
- **Embed lock:** `<iframe src=".../widget">` on a non-allow-listed page is refused.
- **Rate limit / BotID / spend cap:** flood → 429; `curl` session-create blocked; test budget → 402.
- **Streaming:** drop the connection mid-answer → the widget reattaches and finishes.
- **Baseline:** `npm run typecheck` and `npm test` green in both repos.

---

## 11. Operational notes (learned in testing, 2026-08-03)

- **A partner search takes 30–60s** and streams **nothing** while the tool runs. The proxy
  injects an SSE keep-alive comment every 15s (`lib/partner-proxy.ts`) because browsers drop
  idle connections and surface it as `network error`. **Don't add a proxy/CDN that buffers or
  times out event streams** — the route already sets `no-transform` and `X-Accel-Buffering: no`.
- **Run one partner instance per Azure deployment.** Multiple copies share the same TPM quota.
- **Empty bubble ≠ hang.** During the search the assistant bubble is empty; a progress
  indicator is still an open UX item.
- **Rotate the keys committed in the repo-root `.mcp.json`** (LangSmith + Stitch) and move
  them to env config.
- **Keep LangSmith on EU with `LANGSMITH_RECORD_IO=false`** (member data / GDPR).
- **Alert on Firewall blocks and gateway 429/402** — the early-warning signals.

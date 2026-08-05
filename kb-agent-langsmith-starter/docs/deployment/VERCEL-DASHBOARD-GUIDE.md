# Deploy & Secure Navio — Dashboard Walkthrough (no CLI)

Click-by-click guide for deploying and protecting Navio entirely from the **vercel.com
dashboard** (no terminal). Companion to [`VERCEL-RUNBOOK.md`](VERCEL-RUNBOOK.md) (CLI) and
[`PUBLIC-WIDGET-DEPLOYMENT.md`](PUBLIC-WIDGET-DEPLOYMENT.md) (the *why*).

Do the phases in order. Don't move on until the ✅ checkpoint passes.

> **You are deploying TWO projects** (since the Partner Agent was added):
>
> | # | Project | GitHub repo | **Root Directory** |
> |---|---|---|---|
> | 1 | **navio-widget** (public) | `AiLabSportnavi/CortexKit` | `kb-agent-langsmith-starter` |
> | 2 | **navio-partner** (internal) | `AiLabSportnavi/SportnaviPartnerRecomandationBot` | `partner-recommendation-agent` |
>
> **Deploy project 2 first** — project 1 needs its URL.

> **Lessons from the first deployment:**
> - Vercel deploys from a **Git repo** — there's no "upload a folder" button.
> - **Root Directory is mandatory** for both projects. Skip it and every URL returns **404**,
>   because Vercel builds the empty repo root.
> - This account was on **Hobby**; some controls are limited (table at the bottom). The core
>   protection — spend cap + origin lock + one rate-limit rule — still works on Hobby.

---

## ⚠️ Before anything — protect your secrets

The repo root has `CortexKit/.mcp.json` with real-looking API keys. Confirm `.gitignore`
covers them (it already should):

```
.mcp.json
.env.local
.env*.local
node_modules/
.next/
.output/
.eve/
.vercel/
```

Also **rotate** those LangSmith and Stitch keys — once a key has been in a shared repo, treat
it as burned.

---

## Phase A — Both repos on GitHub

`CortexKit` is already on GitHub (`AiLabSportnavi/CortexKit`). The Partner Agent is a
**separate repo** (`AiLabSportnavi/SportnaviPartnerRecomandationBot`) — it is *nested inside*
the CortexKit folder but tracked independently, so push it from **its own** folder.

If you use **GitHub Desktop**: `File → Add local repository` → select
`CortexKit\SportnaviPartnerRecomandationBot` (its own repo) → commit → **Publish repository**
(**Private**).

✅ **Checkpoint:** both repos are on github.com, and `.mcp.json` / `.env.local` are **not**.

---

## Phase B — Import project 2 (Partner Agent) first

1. **vercel.com** → **Add New… → Project**.
2. Import `SportnaviPartnerRecomandationBot`. (First time: **Install** to connect Vercel to
   GitHub and grant repo access.)
3. **Root Directory** → **Edit** → select **`partner-recommendation-agent`**. *(Mandatory.)*
4. Expand **Environment Variables** and add:
   - `AZURE_AI_CHATBOT_OPENAI_ENDPOINT`
   - `AZURE_AI_CHATBOT_API_KEY`
   - `AZURE_AI_CHATBOT_DEPLOYMENT_NAME` = `gpt-4.1`
   - `MEMORY_SUPABASE_URL`
   - `MEMORY_SUPABASE_SERVICE_ROLE_KEY` — **service-role** key (RLS is on with no policies;
     the anon key silently returns zero rows)
   - `EMBEDDING_API_URL`, `EMBEDDING_API_KEY`
5. **Deploy**.

✅ **Checkpoint:** open the deployment URL → its console loads → ask *"Yoga in Bochum"* → real
partners come back. **Copy this URL** — project 1 needs it.

---

## Phase C — Import project 1 (Navio widget)

1. **Add New… → Project** → import `CortexKit`.
2. **Root Directory** → **Edit** → **`kb-agent-langsmith-starter`**. *(Mandatory.)*
3. **Framework Preset** auto-detects; leave build settings default.
4. **Environment Variables:**
   - `AZURE_AI_CHATBOT_OPENAI_ENDPOINT`
   - `AZURE_AI_CHATBOT_API_KEY`
   - `AZURE_AI_CHATBOT_DEPLOYMENT_NAME` = `gpt-4.1`
   - **`PARTNER_AGENT_HOST`** = the project-2 URL from Phase B ⬅ **new, required for the
     "Partner finden" menu option**
   - (optional) `LANGSMITH_*`, `SALESFORCE_*` (blank ⇒ contact form runs in simulate mode)
5. **Deploy**.

✅ **Checkpoint:** build succeeds and you get a URL like `https://navio-widget.vercel.app`.

---

## Phase D — Test all three menu options

1. `https://<project-1-url>/eve/v1/health` → `{"ok":true,...}`.
2. `https://<project-1-url>/` → dev console; ask *"Was ist Firmenfitness?"* → it answers.
3. `https://<project-1-url>/widget` → the real widget. Click **Mit Navio chatten** →
   **Zustimmen** → you should see **three cards**:
   - **FAQ-Agent** → answers KB questions.
   - **Partner finden** → *"Yoga in Bochum"* → real partners.
     ⏱️ **Allow 30–60 seconds.** The bubble stays empty while the search runs — that is
     normal, not a hang. A **503** means `PARTNER_AGENT_HOST` is missing or wrong.
   - **Kontaktformular** → submits (simulate mode if `SALESFORCE_*` is blank).

✅ **Checkpoint:** all three options work. (Credential errors → re-check env vars, then
**Deployments → ⋯ → Redeploy**.)

---

## Phase E — Firewall: origin lock + rate limits

On **project 1**: project → **Firewall** → **Custom Rules** → **New Rule**. **Set every
rule's action to `Log` first**, **Save**, then **Publish** at the top of the Firewall page.

### Rule A — Allow only Sportnavi origins
- If: **Request Path** *starts with* `/eve/v1/`
- **AND** **Request Header** `Origin` *exists*
- **AND** **Request Header** `Origin` *is not any of*
  `https://chat.sportnavi.de, https://www.sportnavi.de, https://sportnavi.de`
- Then: **Log** (later → **Deny**)

> ⚠️ **While testing on the `*.vercel.app` URL (before the custom domain in Phase H):** the
> widget's own calls carry `Origin: https://<project>.vercel.app`, which is **not** in the
> list — a **Deny** would block your own widget. Keep this rule on **Log** until the custom
> domain is live, or temporarily add the `*.vercel.app` origin and remove it afterwards.
>
> The **"Origin exists"** condition is deliberate — it lets no-Origin requests (health checks
> and the same-origin stream) through, so streaming never breaks.

### Rule B — Rate limit starting a chat
- If: **Method** `POST` **AND** **Path** *equals* `/eve/v1/session`
- Then: **Rate Limit** → 20 / 60s by **IP** (+ **JA4**) → **Log** (later → **429**)

### Rule C — Rate limit messages
- If: **Method** `POST` **AND** **Path** *starts with* `/eve/v1/session/`
- Then: **Rate Limit** → 60 / 60s by IP → **Log** (later → **429**)

### Rule D — Rate limit the stream
- If: **Method** `GET` **AND** **Path** *starts with* `/eve/v1/session/`
- Then: **Rate Limit** → 120 / 60s by IP → **Log** (later → **429**)

### Rule E — The partner proxy and the contact form ⬅ new
- If: **Path** *starts with* `/api/partner/` → **Rate Limit** 60 / 60s by IP → **Log**
- If: **Method** `POST` **AND** **Path** *equals* `/api/contact` → **Rate Limit** 15 / 60s by
  IP → **Log**

> The contact form's in-code limiter is **per serverless instance**, so it is *not*
> authoritative — this Firewall rule is the real control.
>
> ⚠️ Don't set a tight limit on the partner **stream**: one search holds a connection for
> 30–60s and clients may reconnect.

Then **Publish**. Let real traffic run for a day, open **Firewall → Traffic**, confirm no
genuine users are matched, then edit each rule **Log → Deny / 429** and **Publish** again.

✅ **Checkpoint:** rules show **Active** in Log mode; Traffic shows matches when you test from
another site.

> On **Hobby** you get **1 rate-limit rule** (3 custom rules total). Prioritize **Rule A
> (origin lock)** + **Rule B (session-create limit)**. DDoS protection is automatic and free.
> Rate-limit counts are per-region, which is exactly why Phase F is the real safety net.

---

## Phase F — Cap your spend

**Both projects call Azure OpenAI**, so the cap must be on the Azure side (or on a gateway
that both use).

### 🟢 Recommended baseline (any plan)
In the **Azure Portal** (not Vercel):
- **Azure OpenAI resource → Model deployments → `gpt-4.1` → Edit** → set a
  **Tokens-Per-Minute (TPM)** limit.
- **Cost Management → Budgets → +Add** → monthly budget with an email alert.

⚠️ **Size TPM against the partner agent's worst-case turn.** It injects one profile block per
partner into a single model call. At `maxPartners: 100`, a dense city (Bochum) produced a
~60–78k-token call — **larger than the deployment's per-minute allowance** — so it returned
429 on *every* attempt, no matter how long you waited. `maxPartners` is now **40**. If you
lower TPM, verify a worst-case search still fits, or lower `maxPartners` to match.

**Result:** requests/minute capped (Vercel Firewall) + tokens/minute capped (Azure) = cost
can't run away, data stays in the EU, no credit card, no code change.

### 🔵 AI Gateway (later, when you go Pro / multi-app)
For a guaranteed **dollar** hard-stop + provider failover:
1. **Add a Card** (unlocks the gateway + free credit).
2. **Bring Your Own Key** → add your Azure OpenAI so answers stay in the EU.
3. **API Keys** → create a key → give it a **budget** → this is the hard cap.
4. Project → **Environment Variables** → add `AI_GATEWAY_API_KEY` + `AI_GATEWAY_MODEL` (the
   Azure slug from **Model List**) → **Redeploy**.

The code already switches to the gateway automatically once `AI_GATEWAY_MODEL` is set.

✅ **Checkpoint:** the Azure deployment shows the new TPM limit; a flood is throttled by
Rule B + the Azure ceiling instead of running up cost.

---

## Phase G — BotID (invisible bot blocking)

Needs a small code change first (edit, commit via GitHub Desktop → auto-redeploy):

1. In `kb-agent-langsmith-starter/next.config.mjs`:
   ```ts
   import { withBotId } from "botid/next/config";
   export default withBotId(withEve(nextConfig));
   ```
   Commit + push → Vercel deploys a preview. Confirm it still builds/loads.
2. Dashboard: enable **BotID Deep Analysis** for the project.
3. Settings → Environment Variables → `BOTID_ENABLED` = `true` **and**
   `NEXT_PUBLIC_BOTID_ENABLED` = `true` → Save → **Redeploy**.

✅ **Checkpoint:** the widget opens with no visible puzzle; a scripted/`curl` call to
`/eve/v1/session` is blocked.

> **Deep Analysis requires Pro.** On **Hobby** you get **Basic** only. Until you upgrade, lean
> on Rule B + the Phase F spend cap.

---

## Phase H — Custom domains

**Project 1 (public):** Settings → **Domains** → add **`chat.sportnavi.de`** → add the shown
**CNAME** at your DNS host → wait for verification.

**Project 2 (internal):** add e.g. **`partner.sportnavi.de`**. Then go back to **project 1 →
Environment Variables** and update **`PARTNER_AGENT_HOST`** to that domain → **Redeploy**.

✅ **Checkpoint:** `https://chat.sportnavi.de/eve/v1/health` → 200, and **Partner finden**
still works after the redeploy. (Now flip Rule A to **Deny** and publish — see the Phase E
warning.)

⚠️ **Project 2 should not stay openly public.** Restrict it (Firewall rule, shared-secret
header, or Deployment Protection) — see [`PUBLIC-WIDGET-DEPLOYMENT.md`](PUBLIC-WIDGET-DEPLOYMENT.md)
§6. **Not implemented yet.**

---

## Phase I — Embed on the website

Give your web team one line to drop on any sportnavi.de page (ideally the global
layout/footer so it appears site-wide):

```html
<script src="https://chat.sportnavi.de/launcher.js" async></script>
```

That's the floating chat button. The script derives its own origin from its `src`, so the same
tag works on production, previews, and localhost with no edits.

Who may **embed** it is controlled by **`WIDGET_FRAME_ANCESTORS`** (project 1 env → enforced
as `Content-Security-Policy: frame-ancestors` on `/widget`). Default allows sportnavi.de. To
let another site embed the widget, add its origin there **and** to Firewall Rule A, then
redeploy.

Full embedding workflow: [`PUBLIC-WIDGET-DEPLOYMENT.md`](PUBLIC-WIDGET-DEPLOYMENT.md) §9.

✅ **Final checks:** all three menu options work from sportnavi.de; a foreign-site `fetch` to
the API is denied; an `<iframe>` of `/widget` on a non-allow-listed page is refused; a flood
triggers 429; the spend cap holds. Watch it live: **Firewall → Traffic**, **AI Gateway →
Logs**, and the project's **Observability / Agent Runs**.

---

## Rollback

Project → **Deployments** → pick a known-good build → **⋯ → Promote to Production**.
Env-var changes require a **Redeploy** to take effect.

---

## Plan limits: Hobby vs Pro

| Control | Hobby | Pro |
|---|---|---|
| AI Gateway hard spend cap | ✅ | ✅ |
| Origin allowlist (firewall custom rule) | ✅ | ✅ |
| Rate-limit rules | ⚠️ 1 rule (3 custom rules total) | up to 40, JA4 keys |
| BotID | ⚠️ Basic only | **Deep Analysis** (invisible ML) |
| DDoS protection | ✅ automatic | ✅ automatic |

Upgrade to **Pro** when you want full layered rate limits and invisible bot-blocking. Until
then, **spend cap + origin lock + one rate-limit rule** is a solid public-launch baseline.

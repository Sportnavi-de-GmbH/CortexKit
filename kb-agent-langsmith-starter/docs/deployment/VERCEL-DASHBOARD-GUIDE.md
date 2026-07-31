# Deploy & Secure the Navio Widget — Dashboard Walkthrough (no CLI)

Click-by-click guide for deploying and protecting the public Navio chat widget entirely from the
**vercel.com dashboard** (no terminal). Companion to `VERCEL-RUNBOOK.md` (the CLI version) and
`PUBLIC-WIDGET-DEPLOYMENT.md` (the *why*).

Do the phases in order. Don't move on until the ✅ checkpoint passes.

> **Notes from the first live deployment:**
> - The Vercel dashboard deploys from a **Git repo** — there's no "upload a folder" button, so
>   Phase A puts your code on GitHub first.
> - **Root Directory must be set to `kb-agent-langsmith-starter`** (Phase B step 3). If you skip
>   it, every URL returns **404** because Vercel builds the empty repo root.
> - This account is on the **Hobby** plan. Some controls are limited (see the plan-limits table at
>   the bottom). The core protection — AI Gateway spend cap + origin lock + one rate-limit rule —
>   still works on Hobby.

---

## ⚠️ Before anything — protect your secrets

Your repo root has `CortexKit/.mcp.json` with real-looking API keys in it. If you push the whole
folder to GitHub, those keys become public. Before Phase A:

1. Open `CortexKit/.gitignore` (create it if missing) and add these lines:
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
2. Also plan to **rotate** (regenerate) those LangSmith and Stitch keys later — once a key has been
   on disk in a shared repo, treat it as burned.

---

## Phase A — Put the code on GitHub (no terminal)

Use **GitHub Desktop** (a GUI app):

1. Install **GitHub Desktop** from desktop.github.com and sign in.
2. `File → Add local repository` → choose your `CortexKit` folder → it'll offer to "create a
   repository here" → click **Create a repository**.
3. Confirm the `.gitignore` from the warning above is in place (GitHub Desktop shows the file list
   — make sure `.mcp.json` and `.env.local` are **not** in the list of files to be committed).
4. Type a summary like "initial commit" → **Commit to main**.
5. Click **Publish repository** (top bar) → set it **Private** → Publish.

✅ **Checkpoint:** your code is on github.com in a private repo, and `.mcp.json`/`.env.local` are
**not** there.

---

## Phase B — Import into Vercel

1. Go to **vercel.com** → top-right **Add New… → Project**.
2. Under **Import Git Repository**, find your new repo → **Import**. (First time: click **Install**
   to connect Vercel to your GitHub, grant access to the repo.)
3. On the configure screen, the important part: **Root Directory** → click **Edit** → select
   **`kb-agent-langsmith-starter`**. (Your app lives in that subfolder, not the repo root. Skipping
   this is what causes the 404-on-everything symptom.)
4. **Framework Preset** should auto-detect. Leave build settings default (eve/Next handles it).
5. Expand **Environment Variables** and add the required ones (Name → Value → Add):
   - `AZURE_AI_CHATBOT_OPENAI_ENDPOINT`
   - `AZURE_AI_CHATBOT_API_KEY`
   - `AZURE_AI_CHATBOT_DEPLOYMENT_NAME` = `gpt-4.1`
   - (optional) the `LANGSMITH_*` vars from `.env.example`
6. Click **Deploy** and wait for the build.

✅ **Checkpoint:** build succeeds and you get a live URL like `https://your-project.vercel.app`.

---

## Phase C — Test it in the browser

1. Open `https://your-project.vercel.app/eve/v1/health` → you should see `{"ok":true,...}`.
2. Open `https://your-project.vercel.app/` → the dev console; ask it *"Was ist Firmenfitness?"* →
   it should answer.
3. Open `https://your-project.vercel.app/widget` → the actual chat widget.

✅ **Checkpoint:** the agent answers. (If it errors about credentials, re-check the Azure env vars
in Phase B, then redeploy from the **Deployments** tab → **⋯** → **Redeploy**.)

---

## Phase D — Firewall: origin lock + rate limits

Open your project → **Firewall** tab (top of the project page) → **Custom Rules** → **New Rule**.
You'll build up to 4 rules. **Set every rule's action to `Log` first** (it records but blocks
nothing), then **Save**, then click **Publish** (top of the Firewall page) to make the log rules
live.

Each rule is an **If** (conditions) → **Then** (action):

### Rule A — Allow only Sportnavi origins
- If: **Request Path** *starts with* `/eve/v1/`
- **AND** **Request Header** `Origin` *exists*
- **AND** **Request Header** `Origin` *is not any of* `https://chat.sportnavi.de, https://www.sportnavi.de, https://sportnavi.de`
- Then: **Log** (later → **Deny**)

> ⚠️ **While testing on the `*.vercel.app` URL (before the custom domain in Phase G):** the widget's
> own calls carry `Origin: https://<your-project>.vercel.app`, which is **not** in the list — so a
> **Deny** here would block your own widget. Either keep this rule on **Log** until Phase G is done
> and you test from `chat.sportnavi.de`, **or** temporarily add your `*.vercel.app` origin to the
> list and remove it once the custom domain is live.
>
> The **"Origin Exists"** condition is deliberate — it lets no-Origin requests (health checks and
> the same-origin stream) through, so streaming never breaks.

### Rule B — Rate limit starting a chat
- If: **Method** *equals* `POST` **AND** **Path** *equals* `/eve/v1/session`
- Then: **Rate Limit** → 20 requests / 60s, count by **IP** (add **JA4** too). Action when
  exceeded: **Log** (later → **429/Deny**)

### Rule C — Rate limit messages
- If: **Method** `POST` **AND** **Path** *starts with* `/eve/v1/session/`
- Then: **Rate Limit** → 60 / 60s by IP → **Log** (later → **429**)

### Rule D — Rate limit the stream
- If: **Method** `GET` **AND** **Path** *starts with* `/eve/v1/session/`
- Then: **Rate Limit** → 120 / 60s by IP → **Log** (later → **429**)

Then: **Publish**. Let real traffic run for a day, open **Firewall → Traffic** and confirm no
genuine users are being matched. Only then edit each rule's action from **Log → Deny / 429** and
**Publish** again.

✅ **Checkpoint:** rules show as **Active** in Log mode; the Traffic view shows matches when you
test from another site.

> On the **Hobby** plan you get **1 rate-limit rule** (3 custom rules total). If you're on Hobby,
> prioritize **Rule A (origin lock)** + **Rule B (session-create rate limit)**. DDoS protection is
> already on for free — nothing to do. Rate-limit counts are per-region (can leak a bit), which is
> exactly why Phase E is the real safety net.

---

## Phase E — Cap your spend (so a bill can never run away)

You have two options. On Hobby, start with the simple one.

### 🟢 The simpler protection I recommend for now
You've already got the two things that matter most for a Hobby MVP:

1. ✅ **Firewall rate limit (Rule B)** — caps how many requests per minute anyone can send.
2. ➕ **Add one cap on the Azure side** — where the money actually is:

   In the **Azure Portal** (not Vercel):
   - Go to your **Azure OpenAI resource → Model deployments → your `gpt-4.1` deployment → Edit**.
   - Set a low **Tokens-Per-Minute (TPM) limit** (e.g. `10,000`). This is a hard ceiling on how
     fast it can ever spend.
   - (Optional) **Cost Management → Budgets → +Add** → set a monthly $ budget with an email alert.

**Result:** requests/minute capped (Vercel) + tokens/minute capped (Azure) = your cost physically
can't run away, data stays in the EU, no credit card, no code change. That's a solid, safe baseline
for launch.

### 🔵 The gateway (do this later, when you go Pro / multi-app)
If you later want a guaranteed **dollar** hard-stop + automatic provider failover:

1. **Add a Card** (unlocks the gateway + $5 free credit).
2. **Bring Your Own Key** (left nav) → add your Azure OpenAI so answers stay in the EU.
3. **API Keys** → create a key → give it a **budget** (e.g. $20/month, refresh monthly) → this is
   the hard cap.
4. In Vercel project → **Environment Variables**: add `AI_GATEWAY_API_KEY` (that key) +
   `AI_GATEWAY_MODEL` (the Azure slug shown in **Model List**) → **Redeploy**.

Your code is already wired for step 4 — it switches to the gateway automatically once
`AI_GATEWAY_MODEL` is set.

✅ **Checkpoint (simple path):** the Azure deployment shows the new TPM limit; a flood of requests
gets throttled by Rule B + the Azure TPM ceiling instead of running up cost.

---

## Phase F — BotID (invisible bot blocking)

This one needs a tiny code change first (edit in your editor, commit via GitHub Desktop — that
auto-redeploys):

1. In `kb-agent-langsmith-starter/next.config.mjs`, change the bottom to wrap with BotID:
   ```ts
   import { withBotId } from "botid/next/config";
   // ...keep the rest...
   export default withBotId(withEve(nextConfig));
   ```
   Commit + push (GitHub Desktop) → Vercel auto-deploys a preview. Confirm it still builds/loads.
2. Vercel dashboard: enable **BotID Deep Analysis** for the project (in the Firewall/Bot area).
3. Settings → Environment Variables → add `BOTID_ENABLED` = `true` **and**
   `NEXT_PUBLIC_BOTID_ENABLED` = `true` → Save → Redeploy.

✅ **Checkpoint:** the widget still opens with no visible puzzle for you; a scripted/`curl` call to
`/eve/v1/session` gets blocked.

> **Deep Analysis (the invisible ML bot-blocking) requires Pro.** On **Hobby** you get **Basic**
> BotID only. Until you upgrade, lean on Rule B (rate limit) + the Phase E spend cap.

---

## Phase G — Custom domain

Project → **Settings → Domains** → add **`chat.sportnavi.de`** → Vercel shows a **CNAME** record →
add that record at your DNS host (where sportnavi.de's DNS lives) → wait for it to verify.

✅ **Checkpoint:** `https://chat.sportnavi.de/eve/v1/health` returns 200. (Now flip Rule A to
**Deny** and publish — see the Phase D warning.)

---

## Phase H — Embed on the website

Give your web team one line to drop on any sportnavi.de page:

```html
<script src="https://chat.sportnavi.de/launcher.js" async></script>
```

That's the floating chat button. `frame-ancestors` (already in your config) makes sure only
sportnavi.de can embed it.

✅ **Final checks:** foreign-site `fetch` to the API is denied; an `<iframe>` of `/widget` on a
non-Sportnavi page is refused; a flood triggers 429; the spend cap holds. To watch it live:
**Firewall → Traffic**, **AI Gateway → Logs**, and the project's **Observability / Agent Runs**.

---

## Plan limits: Hobby vs Pro

| Control | Hobby | Pro |
|---|---|---|
| AI Gateway hard spend cap (the key cost ceiling) | ✅ | ✅ |
| Origin allowlist (firewall custom rule) | ✅ | ✅ |
| Rate-limit rules | ⚠️ 1 rule (3 custom rules total) | up to 40, JA4 keys |
| BotID | ⚠️ Basic only | **Deep Analysis** (invisible ML) |
| DDoS protection | ✅ automatic | ✅ automatic |

Upgrade to **Pro** when you want full layered rate limits and invisible bot-blocking. Until then,
**AI Gateway spend cap + origin lock + one rate-limit rule** is a solid public-launch baseline.

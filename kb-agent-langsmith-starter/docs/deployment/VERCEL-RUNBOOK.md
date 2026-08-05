# Vercel Runbook — Deploy & Secure Navio (exact commands)

The *how*. Companion to [`PUBLIC-WIDGET-DEPLOYMENT.md`](PUBLIC-WIDGET-DEPLOYMENT.md) (the
*what/why*) and [`VERCEL-DASHBOARD-GUIDE.md`](VERCEL-DASHBOARD-GUIDE.md) (no-terminal version).

> **Two services, two Vercel projects** (see the deployment guide §1):
> | # | Project | Repo | Run commands from |
> |---|---|---|---|
> | 1 | **navio-widget** (public) | `AiLabSportnavi/CortexKit` | `kb-agent-langsmith-starter/` |
> | 2 | **navio-partner** (internal) | `AiLabSportnavi/SportnaviPartnerRecomandationBot` | `partner-recommendation-agent/` |
>
> Always run `vercel` from the **app folder**, not the repo root — that folder is the Vercel
> project root (where `next.config.mjs` lives) and holds `.vercel/project.json`.

> **Golden rule for the firewall:** every rule is **staged as a draft**. Nothing goes live
> until **you** run `vercel firewall publish --yes`. Stage as `log` first, review real
> traffic, then flip to enforce. Never publish blind.

Legend: 🟢 = safe anytime · 🟡 = deploys/changes your live project · 🔴 = you must run it
(interactive or goes live).

**Deploy order: service 2 first** (service 1 needs its URL).

---

## Phase 0 — Link both projects (5 min)

```bash
vercel whoami                                   # 🟢 confirm the right account

cd ../SportnaviPartnerRecomandationBot/partner-recommendation-agent
vercel link                                     # 🔴 create/link project, e.g. "navio-partner"

cd -                                            # back to kb-agent-langsmith-starter
vercel link                                     # 🔴 create/link project, e.g. "navio-widget"
```

---

## Phase 1 — Service 2 (Partner Agent) first

```bash
cd ../SportnaviPartnerRecomandationBot/partner-recommendation-agent

vercel env add AZURE_AI_CHATBOT_OPENAI_ENDPOINT      # 🔴 Production+Preview
vercel env add AZURE_AI_CHATBOT_API_KEY              # 🔴
vercel env add AZURE_AI_CHATBOT_DEPLOYMENT_NAME      # 🔴 e.g. gpt-4.1
vercel env add MEMORY_SUPABASE_URL                   # 🔴
vercel env add MEMORY_SUPABASE_SERVICE_ROLE_KEY      # 🔴 service-role (RLS on, no policies)
vercel env add EMBEDDING_API_URL                     # 🔴
vercel env add EMBEDDING_API_KEY                     # 🔴

vercel deploy                                        # 🟡 prints a preview URL
```

**Checkpoint:**
```bash
vercel curl <partner-preview-url>/eve/v1/health      # 🟢 expect 200
```
Open `<partner-preview-url>/` (its own dev console) and ask *"Yoga in Bochum"* — you should get
real partners. **Note this URL**; service 1 needs it.

> Promote to production (`vercel --prod`) and/or add an internal domain such as
> `partner.sportnavi.de` before wiring service 1 to it.

---

## Phase 2 — Service 1 (widget): env + first PREVIEW deploy

```bash
cd <repo>/kb-agent-langsmith-starter

vercel env add AZURE_AI_CHATBOT_OPENAI_ENDPOINT      # 🔴 Production+Preview
vercel env add AZURE_AI_CHATBOT_API_KEY              # 🔴
vercel env add AZURE_AI_CHATBOT_DEPLOYMENT_NAME      # 🔴 e.g. gpt-4.1
vercel env add PARTNER_AGENT_HOST                    # 🔴 ⬅ service 2's URL from Phase 1
# Optional now: LANGSMITH_* (EU), SALESFORCE_* (blank ⇒ contact form simulate mode)

vercel deploy                                        # 🟡 prints a preview URL
```

**Checkpoint (health + all three menu options):**

```bash
vercel curl <preview-url>/eve/v1/health              # 🟢 expect {"ok":true,...} / 200
```

Then in the browser (you're logged into Vercel, so preview protection passes):
- `<preview-url>/` — dev console; ask *"Was ist Firmenfitness?"* → KB agent answers.
- `<preview-url>/widget` — the real widget. Accept consent, then check **all three cards**:
  - **FAQ-Agent** → answers.
  - **Partner finden** → *"Yoga in Bochum"* → real partners. **Allow 30–60s**; the bubble
    stays empty while the search runs. A 503 here means `PARTNER_AGENT_HOST` is unset/wrong.
  - **Kontaktformular** → submits (simulate mode if `SALESFORCE_*` is blank).

---

## Phase 3 — Firewall: origin allowlist + rate limits (staged as LOG)

On **service 1**. All staged as `log` (records hits, blocks nothing). Adjust origins to match
your domain.

```bash
# Rule A — allow only Sportnavi origins on the API (deny foreign browsers). LOG first.
vercel firewall rules add "Navio: allow only Sportnavi origins" \
  --condition '{"type":"path","op":"pre","value":"/eve/v1/"}' \
  --condition '{"type":"header","key":"Origin","op":"ex"}' \
  --condition '{"type":"header","key":"Origin","op":"ninc","value":["https://chat.sportnavi.de","https://www.sportnavi.de","https://sportnavi.de"]}' \
  --action log --yes                                                            # 🔴 stages a draft

# Rule B — rate limit session CREATE (the expensive route). LOG first.
vercel firewall rules add "Navio: rate limit session create" \
  --condition '{"type":"method","op":"eq","value":"POST"}' \
  --condition '{"type":"path","op":"eq","value":"/eve/v1/session"}' \
  --action rate_limit --rate-limit-window 60 --rate-limit-requests 20 \
  --rate-limit-keys ip --rate-limit-keys ja4 --rate-limit-action log --yes      # 🔴

# Rule C — rate limit follow-up messages (higher; a real chat sends several). LOG first.
vercel firewall rules add "Navio: rate limit messages" \
  --condition '{"type":"method","op":"eq","value":"POST"}' \
  --condition '{"type":"path","op":"pre","value":"/eve/v1/session/"}' \
  --action rate_limit --rate-limit-window 60 --rate-limit-requests 60 \
  --rate-limit-keys ip --rate-limit-action log --yes                            # 🔴

# Rule D — light limit on the stream (reconnects are normal). LOG first.
vercel firewall rules add "Navio: rate limit stream" \
  --condition '{"type":"method","op":"eq","value":"GET"}' \
  --condition '{"type":"path","op":"pre","value":"/eve/v1/session/"}' \
  --action rate_limit --rate-limit-window 60 --rate-limit-requests 120 \
  --rate-limit-keys ip --rate-limit-action log --yes                            # 🔴

# Rule E — the partner proxy (every partner turn) + the contact endpoint.
# The in-code contact limiter is PER-INSTANCE on serverless, so this rule is the real control.
vercel firewall rules add "Navio: rate limit partner proxy" \
  --condition '{"type":"path","op":"pre","value":"/api/partner/"}' \
  --action rate_limit --rate-limit-window 60 --rate-limit-requests 60 \
  --rate-limit-keys ip --rate-limit-action log --yes                            # 🔴

vercel firewall rules add "Navio: rate limit contact form" \
  --condition '{"type":"method","op":"eq","value":"POST"}' \
  --condition '{"type":"path","op":"eq","value":"/api/contact"}' \
  --action rate_limit --rate-limit-window 60 --rate-limit-requests 15 \
  --rate-limit-keys ip --rate-limit-action log --yes                            # 🔴
```

⚠️ **Don't rate-limit `/api/partner/*/stream` tightly** — a partner search holds one long
connection for 30–60s and the client may reconnect.

Review, then publish (**you** run this):

```bash
vercel firewall diff                 # 🟢 see the staged rules
vercel firewall publish --yes        # 🔴 makes the LOG rules live (still blocks nothing)
```

Let real traffic flow, then check what each rule matched (rule IDs from `rules list --json`):

```
https://vercel.com/<team>/<project>/firewall/traffic?filter=<ruleId>
```

**Flip to enforce** once the log data looks right — re-state all conditions, swap the action:

```bash
vercel firewall rules edit "Navio: allow only Sportnavi origins" \
  --condition '{"type":"path","op":"pre","value":"/eve/v1/"}' \
  --condition '{"type":"header","key":"Origin","op":"ex"}' \
  --condition '{"type":"header","key":"Origin","op":"ninc","value":["https://chat.sportnavi.de","https://www.sportnavi.de","https://sportnavi.de"]}' \
  --action deny --yes                                                           # 🔴 stage
# For rate-limit rules, change --rate-limit-action log → 429 the same way.
vercel firewall publish --yes                                                   # 🔴 go live
```

> DDoS protection is on for free. Rate-limit counters are per-region, so treat them as
> shaping; the real cost ceiling is Phase 4.

---

## Phase 4 — Spend cap (the real cost ceiling)

**Both services** call Azure OpenAI — cap both.

**Azure-side (works on any plan):** Azure Portal → OpenAI resource → Model deployments →
`gpt-4.1` → **Edit** → set a **TPM limit**; add **Cost Management → Budgets** with alerts.

⚠️ **Size the TPM against the partner agent's worst-case turn.** It injects one profile block
per partner into a single model call. At `maxPartners: 100` a dense city produced a
~60–78k-token call that exceeded the deployment's per-minute allowance and 429'd **every
time**. `maxPartners` is now **40**. If you tighten TPM, verify a worst-case search still fits.

**Vercel AI Gateway (Pro / multi-app):** dashboard → **AI Gateway** → enable → add Azure
OpenAI (EU) as **BYOK** → **Usage & Budgets** → hard monthly limit + alerts (past it the
gateway returns `402`). Then:

```bash
vercel env add AI_GATEWAY_MODEL      # 🔴 value: openai/gpt-4.1  (Prod+Preview)
vercel deploy                        # 🟡 new preview picks it up
```

Local smoke test through the gateway (OIDC token, ~24h):

```bash
vercel env pull .env.local           # 🟢 provisions VERCEL_OIDC_TOKEN
npm run dev                          # in one terminal
npm run live-check -- "Was ist Firmenfitness?"   # EVE_HOST=http://127.0.0.1:<port>
```

---

## Phase 5 — BotID (invisible bot detection)

`botid` is installed and wired (server + client, env-gated off).

1. **Enable the challenge rewrites** in `next.config.mjs`:
   ```ts
   import { withBotId } from "botid/next/config";
   export default withBotId(withEve(nextConfig));
   ```
   Deploy a **preview** and confirm it still builds/loads before enforcing.
2. Dashboard: enable **BotID Deep Analysis** (Pro).
3. Turn it on (both must match):
   ```bash
   vercel env add BOTID_ENABLED             # 🔴 true
   vercel env add NEXT_PUBLIC_BOTID_ENABLED # 🔴 true
   vercel deploy                            # 🟡
   ```

**Test:** `curl -X POST <url>/eve/v1/session` blocked in production; the real browser widget
passes with no visible challenge.

---

## Phase 6 — Custom domains + production

```bash
# service 1 (public)
vercel domains add chat.sportnavi.de     # 🔴 then add the shown CNAME at your DNS host
vercel --prod                            # 🔴 promote to production

# service 2 (internal) — from its folder
vercel domains add partner.sportnavi.de  # 🔴 optional but recommended
vercel --prod                            # 🔴
```

After service 2 gets its production domain, **update service 1** and redeploy:

```bash
vercel env rm PARTNER_AGENT_HOST --yes && vercel env add PARTNER_AGENT_HOST   # 🔴 new URL
vercel --prod                                                                 # 🔴
```

`frame-ancestors` already allows sportnavi.de (override via `WIDGET_FRAME_ANCESTORS`). Set
`WIDGET_ALLOWED_ORIGINS` only if you serve the widget cross-origin.

⚠️ **Lock down service 2** — it should not be an open public agent. See
[`PUBLIC-WIDGET-DEPLOYMENT.md`](PUBLIC-WIDGET-DEPLOYMENT.md) §6. **Not implemented yet.**

---

## Phase 7 — Embed + verify

Give the marketing team one line for any page (ideally the global template):

```html
<script src="https://chat.sportnavi.de/launcher.js" async></script>
```

Full embedding workflow, including `WIDGET_FRAME_ANCESTORS`:
[`PUBLIC-WIDGET-DEPLOYMENT.md`](PUBLIC-WIDGET-DEPLOYMENT.md) §9.

Final checks (full list in that guide §10): health 200; all three menu options work;
foreign-origin `fetch` denied; `<iframe>` on a non-allow-listed page refused; flood → 429;
BotID blocks curl; spend cap → 402; stream reconnects mid-answer.

**Observe:**
```bash
vercel agent-runs --help                 # 🟢 runtime traces (turns, tokens, tools)
vercel firewall overview                 # 🟢 active rules + blocks
vercel logs <deployment-url>             # 🟢 runtime logs
# AI Gateway logs + spend: dashboard → AI Gateway
```

---

## Rollback

```bash
vercel ls                                # 🟢 list deployments
vercel promote <previous-deployment-url> # 🔴 instant rollback to a known-good build
```

Env-var changes need a **redeploy** to take effect.

---

## Also do from day one
- Rotate the LangSmith + Stitch keys committed in the repo-root `.mcp.json` (outside this
  deploy folder, but still rotate).
- Keep LangSmith on **EU** with `LANGSMITH_RECORD_IO=false` (member data / GDPR).
- Alert on Firewall blocks and AI-Gateway 429/402 — the early-warning signals.
- Keep the partner agent's `maxPartners` and the Azure TPM limit consistent (Phase 4).

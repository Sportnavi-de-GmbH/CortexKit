# Vercel Runbook — Deploy & Secure the Navio Widget (exact commands)

Companion to `PUBLIC-WIDGET-DEPLOYMENT.md` (the *what/why*). This is the *how* — copy-paste
commands, run **from the `kb-agent-langsmith-starter/` folder** (the Vercel project root, where
`next.config.mjs` lives — NOT the CortexKit repo root).

> Golden rule for the firewall: every rule is **staged as a draft**. Nothing goes live until
> **you** run `vercel firewall publish --yes`. We stage as `log` first, review real traffic,
> then flip to enforce. Never publish blind.

Legend: 🟢 = safe to run anytime · 🟡 = deploys/changes your live project · 🔴 = you must run
it (interactive or goes live).

---

## Phase 0 — Link the project (2 min)

```bash
vercel whoami            # 🟢 confirm the right account (you're already logged in)
vercel link              # 🔴 pick scope/team → create or link a project, e.g. "navio"
```

`vercel link` writes `.vercel/project.json` here. Deploy always from this folder.

---

## Phase 1 — Env vars + first PREVIEW deploy

Set the required Azure vars (prompts for the value + which environments). Repeat per variable,
or paste them in the dashboard (Project → Settings → Environment Variables):

```bash
vercel env add AZURE_AI_CHATBOT_OPENAI_ENDPOINT     # 🔴 paste endpoint; choose Production+Preview
vercel env add AZURE_AI_CHATBOT_API_KEY             # 🔴
vercel env add AZURE_AI_CHATBOT_DEPLOYMENT_NAME     # 🔴 e.g. gpt-4.1
# Optional now, recommended: LangSmith (EU) — LANGSMITH_API_KEY, LANGSMITH_ENDPOINT, etc.
```

Deploy a **preview** (safe — not production, gets its own URL):

```bash
vercel deploy            # 🟡 prints a https://<preview>.vercel.app URL
```

**Checkpoint (health + widget):**

```bash
vercel curl <preview-url>/eve/v1/health        # 🟢 expect {"ok":true,...} / 200
```

Then open in your browser (you're logged into Vercel, so preview protection passes):
- `<preview-url>/` — the dev console (sanity-check the agent answers)
- `<preview-url>/widget` — the embeddable widget itself

---

## Phase 2 — Firewall: origin allowlist + rate limits (staged as LOG)

All staged as `log` (records hits, blocks nothing). Adjust the origins if your domain differs.

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
```

Review, then publish (**you** run this):

```bash
vercel firewall diff                 # 🟢 see the 4 staged rules
vercel firewall publish --yes        # 🔴 makes the LOG rules live (still blocks nothing)
```

Let real traffic flow, then check what each rule matched (rule IDs from `rules list --json`):

```
https://vercel.com/<team>/<project>/firewall/traffic?filter=<ruleId>
```

**Flip to enforce** once the log data looks right (no real users caught). Example for the
origin rule — re-state all conditions, swap the action:

```bash
vercel firewall rules edit "Navio: allow only Sportnavi origins" \
  --condition '{"type":"path","op":"pre","value":"/eve/v1/"}' \
  --condition '{"type":"header","key":"Origin","op":"ex"}' \
  --condition '{"type":"header","key":"Origin","op":"ninc","value":["https://chat.sportnavi.de","https://www.sportnavi.de","https://sportnavi.de"]}' \
  --action deny --yes                                                           # 🔴 stage
# For the rate-limit rules, change --rate-limit-action log → 429 (its default) the same way.
vercel firewall publish --yes                                                   # 🔴 go live
```

> DDoS protection is already on for free — nothing to configure. Rate-limit counters are
> per-region, so treat them as shaping; the real cost ceiling is Phase 3.

---

## Phase 3 — AI Gateway spend cap (the real cost ceiling)

Mostly dashboard. Project → **Settings → AI Gateway**:
1. Enable AI Gateway.
2. Add your **Azure OpenAI (EU)** deployment as a **BYOK** provider (keeps inference on your EU
   data path).
3. **Usage & Budgets** → set a hard monthly limit + a warning threshold + alert email/Slack.
   (Hard limit → the gateway returns HTTP 402 and stops spending. This is your guaranteed cap.)

Then point the app at the gateway and redeploy:

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

## Phase 4 — BotID (invisible bot detection)

`botid` is already installed and wired (server + client, env-gated off). Two steps:

1. **Enable the challenge rewrites** — wrap the config export in `next.config.mjs`:
   ```ts
   import { withBotId } from "botid/next/config";
   // ...
   export default withBotId(withEve(nextConfig));
   ```
   Deploy a **preview** and confirm the app still builds/loads before enabling enforcement.
2. Dashboard: enable **BotID Deep Analysis** (Pro) for the project.
3. Turn it on (both must match):
   ```bash
   vercel env add BOTID_ENABLED             # 🔴 true
   vercel env add NEXT_PUBLIC_BOTID_ENABLED # 🔴 true
   vercel deploy                            # 🟡
   ```

**Test:** a `curl -X POST <url>/eve/v1/session` is blocked in production; the real browser
widget passes with no visible challenge.

---

## Phase 5 — Custom domain + production

```bash
vercel domains add chat.sportnavi.de     # 🔴 then add the shown CNAME at your DNS host
vercel --prod                            # 🔴 promote to production
```

`frame-ancestors` already allows sportnavi.de (override via `WIDGET_FRAME_ANCESTORS` env). If
you serve the widget cross-origin instead of same-origin, also set `WIDGET_ALLOWED_ORIGINS`.

---

## Phase 6 — Embed + verify

Give the marketing team one line for any page:

```html
<script src="https://chat.sportnavi.de/launcher.js" async></script>
```

Final checks (see `PUBLIC-WIDGET-DEPLOYMENT.md` §6 for the full list): health 200; foreign-origin
`fetch` denied; `<iframe>` on a non-Sportnavi page refused; rate limit 429s under a flood; BotID
blocks curl; spend cap returns 402 at the test budget; stream reconnects mid-answer.

**Observe:**
```bash
vercel agent-runs --help                 # 🟢 runtime traces (turns, tokens, tools)
vercel firewall overview                 # 🟢 active rules + blocks
# AI Gateway logs + spend: dashboard → AI Gateway
```

---

## Also do from day one
- Rotate the LangSmith + Stitch keys committed in the repo-root `.mcp.json` (they're outside this
  deploy folder, but still rotate them).
- Keep LangSmith on **EU** with `LANGSMITH_RECORD_IO=false` (member data / GDPR).
- Alert on Firewall blocks and AI-Gateway 429/402 — the early-warning signals.

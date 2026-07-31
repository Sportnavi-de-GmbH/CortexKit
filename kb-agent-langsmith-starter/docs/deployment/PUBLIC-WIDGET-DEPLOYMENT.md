# Deploying Navio as a Public Widget on sportnavi.de (MVP)

Hand-off guide for the internal dev team. It covers the **Vercel-account steps** that
can't live in code (custom domain, Firewall, BotID, AI-Gateway spend cap) plus how to
**embed** the widget and **verify** it. Full rationale is in the architecture plan
(`.claude/plans/i-d-like-bubbly-pearl.md`); this is the checklist.

**What's already in the repo (code, done):**
- `agent/channels/eve.ts` — anonymous-but-origin-checked route auth, visitor-id stamping,
  and the server-side BotID enforcement gate.
- `agent/agent.ts` — model routing switches to the AI Gateway when `AI_GATEWAY_MODEL` is set.
- `app/widget/page.tsx` — the embeddable chat (same-origin to the API; BotID client init).
- `public/launcher.js` — the one-line embed script.
- `next.config.mjs` — `frame-ancestors` (who may embed) + hardening headers.

**Assumed plan:** Vercel **Pro**. Embed style: **launcher script + iframe**.

---

## 1. Deploy + custom domain

1. Put this repo under **git** (it isn't yet) and import the project into Vercel.
2. Set the environment variables from `.env.example` in **Vercel → Settings → Environment
   Variables** (Production + Preview). Azure keys are required; leave `AI_GATEWAY_MODEL`
   blank until step 4; keep `BOTID_ENABLED`/`NEXT_PUBLIC_BOTID_ENABLED` `false` until step 3.
3. Add the custom domain **`chat.sportnavi.de`** (Vercel → Settings → Domains) and point the
   DNS `CNAME` at Vercel. The widget and API both live here; keeping it a dedicated subdomain
   keeps the chatbot independent of the marketing site.
4. Confirm `GET https://chat.sportnavi.de/eve/v1/health` returns `200` (always public).

---

## 2. Vercel Firewall — Origin allowlist + rate limiting (Layers 1–2)

Vercel → **Firewall → Custom Rules**. **Stage every rule as `Log` first**, review real
traffic under Firewall → Traffic, then switch to the enforcing action.

**Rule A — Origin allowlist (deny foreign browsers).**
- Match: request path starts with `/eve/v1/` **AND** header `Origin` **is not** one of
  `https://chat.sportnavi.de`, `https://www.sportnavi.de`, `https://sportnavi.de`.
- Action: **Deny**. (Leave requests with *no* `Origin` alone — same-origin GET streams omit
  it; those are covered by rate limiting + BotID.)

**Rule B — Rate limit session creation (the expensive route).**
- Match: `POST /eve/v1/session`. Keys: **IP + JA4**. Window 60s.
- Start limit generous (e.g. 20/min), action **Log**; after review, set ~5–10× real peak and
  action **429**.

**Rule C — Rate limit follow-up messages.**
- Match: `POST /eve/v1/session/` (the `:id` turns). Higher limit than B (a real chat sends
  several messages). IP + JA4, 60s, `429` after review.

**Rule D — Light limit on the stream.**
- Match: `GET /eve/v1/session/*/stream`. Generous limit (reconnects are normal). `429` after review.

> DDoS mitigation (Layer 0) is already on for every deployment — nothing to configure, and
> blocked traffic isn't billed. Counters are **per region**, so treat these as shaping; the
> true cost ceiling is the AI-Gateway budget (step 4).

---

## 3. Vercel BotID — invisible bot detection (Layer 3)

1. `botid` is already installed. The server gate (`checkBotId` from `botid/server`) and the
   client init (`initBotId` from `botid/client/core`) are already wired in the code, both
   env-gated off.
2. Add the BotID proxy rewrites so the challenge is served first-party: wrap the export in
   `next.config.mjs` with `withBotId` from **`botid/next/config`**, i.e.
   `export default withBotId(withEve(nextConfig));` (per
   <https://vercel.com/docs/botid/get-started>). Left out of the committed config so the
   `withBotId`+`withEve` rewrite composition is validated on a real Vercel build before enabling.
3. Enable Deep Analysis for the project (**Pro**, ~$1 / 1,000 protected session-starts).
4. Set **both** flags to `true` in Vercel env: `BOTID_ENABLED` (server gate in
   `agent/channels/eve.ts`) and `NEXT_PUBLIC_BOTID_ENABLED` (client init in the widget). They
   must match, and `checkLevel` on client and server must agree.
5. Because the widget is an iframe served from `chat.sportnavi.de`, the challenge and the API
   call share that origin — no `extraAllowedHosts` needed, and nothing to add to sportnavi.de.

---

## 4. Vercel AI Gateway — the hard spend cap (Layer 5, non-negotiable)

1. In the **AI Gateway** dashboard, add your **Azure OpenAI (EU)** deployment as a **BYOK**
   provider (this keeps inference on your EU data path).
2. Set a **budget** with a hard limit + alert threshold (per day/month). Past the limit the
   gateway returns `402` and stops spending — your guaranteed cost ceiling.
3. Set `AI_GATEWAY_MODEL` in Vercel env to the gateway model id backed by your Azure BYOK
   provider (e.g. `openai/gpt-4.1`). The code then routes all model calls through the gateway.
4. (Optional, follow-up) Attribute spend per visitor: thread the `snv_vid` visitor id
   (already on `ctx.session.auth.current.attributes.visitorId`) into the model call's
   `providerOptions.gateway.user` / `tags`. Not required for the cap to work.

On Vercel, gateway auth is automatic via OIDC — no gateway key needed. Provider keys never
reach the browser.

---

## 5. Embed on sportnavi.de

Give the marketing-site team **one line** for any page:

```html
<script src="https://chat.sportnavi.de/launcher.js" async></script>
```

It adds the floating chat button and opens Navio in an iframe. Updates ship centrally by
redeploying this project. `frame-ancestors` (in `next.config.mjs`, override via
`WIDGET_FRAME_ANCESTORS`) already restricts embedding to Sportnavi.

---

## 6. Verify before flipping rules to enforce

- **Health:** `GET /eve/v1/health` → 200 unauthenticated.
- **Origin lock:** a `fetch("https://chat.sportnavi.de/eve/v1/session", {method:"POST"})` from
  a non-Sportnavi page is denied; the same call from inside the widget works.
- **Embed lock:** `<iframe src="https://chat.sportnavi.de/widget">` on a non-Sportnavi test
  page is refused by the browser (`frame-ancestors`).
- **Rate limit:** script `POST /eve/v1/session` past the threshold → `429` (after confirming
  real usage stayed under the limit in Log mode).
- **BotID:** a `curl`/headless call to `POST /eve/v1/session` is blocked in production; a real
  browser in the widget passes with no visible challenge.
- **Spend cap:** set a low test budget → the gateway returns `402` and stops once exceeded.
- **Streaming:** drop the connection mid-answer → the widget reattaches and the answer finishes.
- **Baseline still green:** `npm run typecheck` and `npm test`.

---

## 7. Also do from day one

- Rotate the secrets currently committed in the repo `.mcp.json` (LangSmith + Stitch keys) and
  move them to env config.
- Keep LangSmith on **EU** with `LANGSMITH_RECORD_IO=false` (member data / GDPR).
- Alert on Firewall blocks and AI-Gateway `429`/`402` — those are the early-warning signals.

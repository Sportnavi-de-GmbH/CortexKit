# CLAUDE.md — kb-agent-langsmith-starter (Navio widget)

Long-term project memory for the **Navio** widget app. Read this first; it should be enough to
work productively without re-investigating.

**Last verified against source: 2026-08-03** (branch `feat/observability-cost-audit`).

> **Scope.** This file covers **service 1** — the public Navio widget in this folder. The
> **Partner Agent** it talks to is **a separate repo** with its own docs; see §3 and the
> workspace-level [`../CLAUDE.md`](../CLAUDE.md).
> **Rule:** `agent/`, `lib/`, `app/`, `components/` source wins over any prose, including this
> file.

---

## 1. What this project is

**Navio** is Sportnavi's public, anonymous, login-less chat widget, embedded on
[sportnavi.de](https://sportnavi.de) via a one-line `<script>` tag. It is built on the
[eve](https://www.npmjs.com/package/eve) framework and serves **three** things behind one
menu:

1. **FAQ-Agent** — the KB/FAQ chatbot. No tools, no RAG; the knowledge base is baked into the
   system prompt.
2. **Partner finden** — a partner/studio finder, powered by a **separate** RAG agent reached
   through a same-origin proxy (§3).
3. **Kontaktformular** — a contact form that creates a Salesforce Case server-side.

It is also the reference implementation for
[`EVE_LANGSMITH_TRACING_GUIDE.md`](../docs/reference/EVE_LANGSMITH_TRACING_GUIDE.md) —
OpenTelemetry tracing, failure hooks, datasets, rate-limited evals, LLM-as-judge.

---

## 2. The widget: screens and menu structure

`components/navio/NavioWidget.tsx` is a screen state machine. `Screen` =
`greeting | consent | menu | chat | partner | contact | info`.

```
launcher.js (floating button on sportnavi.de)
   └─ iframe → /widget
        greeting  "Mit Navio chatten"
          └─ consent   (one GDPR gate; covers all three options)
               └─ MENU  (components/navio/NavioMenu.tsx — three cards)
                    ├─ "FAQ-Agent"        → screen "chat"     → KB agent      (same-origin /eve/v1/*)
                    ├─ "Partner finden"   → screen "partner"  → Partner agent (/api/partner/* proxy)
                    └─ "Kontaktformular"  → screen "contact"  → POST /api/contact → Salesforce
               └─ ⓘ  → screen "info"
```

**Menu card conventions** (`docs/design/WIDGET-DESIGN-GUIDELINES.md`): the palette is
deliberately two-colour — `--brand-green` (`#95c11e`) is the single call-to-action / AI-chat
colour, `--brand-orange` (`#ec6607`) means human hand-off. So **both chat cards are green**
(`Bot` and `MapPin` icons) and only the contact card is orange (`Mail`). **Do not introduce a
third brand colour.**

**Two eve clients, one widget.** `app/widget/page.tsx` mounts both:

```ts
const faqAgent     = useEveAgent();                          // KB agent, same-origin
const partnerAgent = useEveAgent({ host: "/api/partner" });  // partner agent, via the proxy
```

`useEveAgent` is lazy (no session until the first `send()`), so mounting the partner client
costs nothing and the widget still works when no partner host is configured.
`NavioWidget` takes `{ faqAgent, partnerAgent }` and picks `activeAgent` from the screen;
`ChatBody`/`InputBar` are shared, parameterised by a per-screen `CHAT_CFG` (greeting,
quick-replies, placeholder).

---

## 3. The Partner Agent integration (added 2026-08-03)

**Architecture: a separate service behind a same-origin proxy.**

```
widget → /api/partner/eve/v1/*  (this app)  → PARTNER_AGENT_HOST → partner agent (own repo/deploy)
```

- **Why a proxy:** the browser only ever talks to **one origin**, so the existing consent
  gate, origin allowlist, BotID and Firewall rules all still apply, and there is **no CORS**.
- **Code:** `app/api/partner/[...path]/route.ts` (thin) over `lib/partner-proxy.ts` (logic,
  unit-tested in `tests/partner-proxy.test.ts`).
- **Config:** `PARTNER_AGENT_HOST`. **Unset ⇒ the proxy returns 503** and the rest of the
  widget keeps working.

**Three non-obvious things `lib/partner-proxy.ts` must keep doing:**

1. **Only forward paths starting with `eve/`** — it is not an open proxy (SSRF guard).
2. **Strip `content-encoding` (and `content-length`) from the response.** Node's `fetch`
   auto-decompresses the upstream body; relaying a stale `content-encoding: gzip` header makes
   the browser try to gunzip plain text → `Failed to fetch`.
3. **Inject an SSE keep-alive comment every 15s** on `text/event-stream` responses, plus
   `Cache-Control: no-transform` and `X-Accel-Buffering: no`. A partner search is **30–60s of
   total stream silence** (tool runs, then the model writes); browsers drop idle connections
   and surface it mid-turn as `network error`. curl doesn't, which is why this only reproduced
   in the UI.

**The partner agent is a separate git repo** (`AiLabSportnavi/SportnaviPartnerRecomandationBot`),
nested in the workspace but untracked here. Don't `git add` it from this repo. Two fixes made
there on 2026-08-03 are load-bearing for this integration (see §9).

---

## 4. The FAQ agent: prompt-embedded, no tools

- **Tool policy:** 0 active tools **by design**. eve ships built-ins unless each is disabled,
  so `agent/tools/` holds one `disableTool()` sentinel per built-in (11 files: `agent`,
  `ask_question`, `bash`, `glob`, `grep`, `load_skill`, `read_file`, `todo`, `web_fetch`,
  `web_search`, `write_file`). Disabling `web_search` is deliberate — it would give the model
  a source of truth outside the curated KB.
- **Knowledge:** in-prompt injection. No RAG, no vector store, no runtime file reads.
- **Model:** Azure OpenAI (`AZURE_AI_CHATBOT_DEPLOYMENT_NAME`, default `gpt-4.1`), resolved
  lazily in `agent/agent.ts`; degrades to the `openai/gpt-4.1` gateway id so the module stays
  importable with an empty environment (CI has no secrets). Setting `AI_GATEWAY_MODEL` routes
  through the Vercel AI Gateway (activates the hard spend cap).
- **Session budgets** (`agent/agent.ts` `limits`): `maxInputTokensPerSession` 250k,
  `maxOutputTokensPerSession` 20k, both env-tunable (`NAVIO_MAX_*`). eve's default is 40M
  input / uncapped output — far too loose for a public anonymous endpoint.
- **Prompt size: ~16.7k tokens** (measured by `npm run cache:check`). Older docs said
  "~41.5k"/"~71 KB"; that is wrong.

**The prompt is the product.** To change behaviour, edit `agent/instructions.md` — not code.
Sections: `=== IDENTITY ===`, `=== KNOWLEDGE BASE ===`, `=== BEHAVIOR RULES ===`,
`=== CONVERSATIONAL INTELLIGENCE ===`, `=== HARD LIMITS (NIEMALS VERLETZEN) ===`.
`agent/kb/kb.md` is a **reference copy** of the KB docs only — editing it changes nothing.

---

## 5. Security model (public, anonymous endpoint)

Defense in depth — no single gate. `agent/channels/eve.ts` walks, in order:

1. **`requestSizeLimit()`** — rejects bodies over `NAVIO_MAX_REQUEST_BYTES` (default 16 KB)
   via `Content-Length`, **before** BotID/origin checks and long before a model call.
2. **`botCheck()`** — BotID on session-create only; off unless `BOTID_ENABLED=true`.
3. **`widgetOrigin()`** — origin allowlist; accepts anonymously and stamps a visitor id
   (`snv_vid`). Requests with **no** `Origin` are allowed through (same-origin GET streams
   legitimately omit it) and left to the edge controls.
4. **`localDev()`** — loopback only.

`Origin` is browser-set and unforgeable by page JS, so this blocks other sites' browser code —
but **not** curl. That's what BotID, Vercel Firewall rate limits and the spend cap are for.
Who may **embed** the widget is separate: `frame-ancestors` in `next.config.mjs`
(`WIDGET_FRAME_ANCESTORS`).

**Contact form** (`app/api/contact/route.ts`): server-only Salesforce credentials, origin
check, zod validation, `maxDuration = 30`, an `Idempotency-Key` guard against double-submits,
and **PII-safe logging** (`safeShape()` logs field *names and sizes*, never values).
⚠️ Its in-code rate limiter is **per serverless instance** — the real control is a Vercel
Firewall rule.

---

## 6. Observability (LangSmith EU)

- `lib/langsmith.ts` — single source of truth: EU region constant, enablement gate, span
  filter, trace anchors, turn journal, failure payloads.
- `agent/instrumentation.ts` — OTLP → LangSmith EU; renames spans to business language;
  de-duplicates usage so cost isn't double-counted; publishes the trace anchor.
- `agent/hooks/langsmith.ts` — the **only** path from a failure to LangSmith (eve emits
  failures as stream events, never exceptions).

**Invariants:** EU endpoint everywhere · **no key ⇒ no-op** (a fresh clone runs
credential-free) · **hooks never throw** · content capture off unless
`LANGSMITH_RECORD_IO=true` · one request = one trace (deterministic OTLP span-id → run-id).

---

## 7. Development workflow

```bash
npm install
cp .env.example .env.local          # fill Azure vars; everything else optional
npm run dev:ui                      # Next.js console + widget (the normal way to run)
npm run dev                         # eve backend only
npm run typecheck                   # tsc --noEmit — must exit 0
npm test                            # vitest
npx eve info                        # lists the agent; confirms 11 disabled tools
```

| Script | Purpose |
|---|---|
| `live-check` | one real turn against the dev server |
| `cache:check` | measures the prompt + Azure prompt-cache hit |
| `contact:check` | live contact-form submission |
| `eval:upload` / `eval:verify` / `eval:run` | dataset + two-phase eval |

**Running the full widget locally (both services):**

```powershell
# terminal 1 — partner agent (separate repo)
cd ..\SportnaviPartnerRecomandationBot\partner-recommendation-agent
npm run dev:ui -- -p 3001

# terminal 2 — this app
npm run dev:ui -- -p 3010     # .env.local: PARTNER_AGENT_HOST=http://127.0.0.1:3001
```

Then open **`http://localhost:3010/widget`**. Use `127.0.0.1` (not `localhost`) in
`PARTNER_AGENT_HOST` — Node's `fetch` may resolve `localhost` to IPv6 and fail.

**Windows:** `src/internal/authored-module-map-loader.ts` is a required eve 0.25.x dev-host
shim; without it `POST /eve/v1/session` fails with `ERR_MODULE_NOT_FOUND`.
`lib/load-env.ts` must be imported **first** in every entry point.

---

## 8. Deployment status

**Nothing is deployed from this repo yet** — there is no `vercel.json` and no `.vercel/` link.
The deployment docs describe the intended setup:

- [`docs/deployment/PUBLIC-WIDGET-DEPLOYMENT.md`](docs/deployment/PUBLIC-WIDGET-DEPLOYMENT.md)
  — architecture, env matrix, Firewall, spend cap, **and the complete embedding workflow (§9)**.
- [`docs/deployment/VERCEL-RUNBOOK.md`](docs/deployment/VERCEL-RUNBOOK.md) — CLI, copy-paste.
- [`docs/deployment/VERCEL-DASHBOARD-GUIDE.md`](docs/deployment/VERCEL-DASHBOARD-GUIDE.md) —
  click-by-click.

**Shape:** **two Vercel projects**, deployed **partner agent first**:

| # | Project | Repo | Root Directory |
|---|---|---|---|
| 1 | navio-widget (public) | `AiLabSportnavi/CortexKit` | **`kb-agent-langsmith-starter`** |
| 2 | navio-partner (internal) | `AiLabSportnavi/SportnaviPartnerRecomandationBot` | **`partner-recommendation-agent`** |

Root Directory is mandatory for both — skipping it makes every URL 404.
Service 1's `PARTNER_AGENT_HOST` points at service 2. Embedding is one `<script src=".../launcher.js">`
tag; `launcher.js` derives its own origin from its `src`, so the same tag works on prod,
preview, and localhost.

---

## 9. Hard-won lessons (do not re-learn these)

1. **Partner searches are size-limited, not rate-limited.** The partner agent injects one
   profile block per partner into a single model call. At `maxPartners: 100`, a dense city
   (Bochum: 30 home + 70 borrowed) produced a ~418 KB tool result ≈ 42k tokens and a
   ~60–78k-token model call — **larger than the Azure deployment's whole per-minute
   allowance**, so it returned 429 on *every* attempt regardless of spacing. Cities whose
   candidates ran out early (Hamburg, 36) stayed small and worked, which made it look
   intermittent. **Fixed** in the partner repo by retuning
   `agent/config/partner-injection.config.ts` — as of **2026-08-04** it resolves up to
   **40 candidates** (`minPartners`/`maxPartners: 40`, `maxCities: 8`) and renders only the
   top **5** as full profiles (`finalRecommendations: 5`), which is what keeps the model call
   small. Presets: `PRODUCTION` (default), `WIDE_CONTEXT` (60), `BALANCED` (30), `STRICT_CITY`.
   Keep the Azure TPM ceiling consistent with these numbers.
2. **`ask_question` produces no assistant message.** When a query lacked a city, the partner
   model called eve's built-in `ask_question`, which emits an **`input.requested`** event and
   ends the turn with zero `message.appended` — the dev console renders that, this widget does
   not, so the user saw an empty bubble forever. **Fixed** in the partner repo by adding an
   `ask_question` `disableTool()` sentinel, so clarification streams as normal prose.
3. **Long silent streams die in browsers, not in curl.** Hence the proxy keep-alive (§3).
   Never debug a streaming issue with curl alone.
4. **Prompt caching is the dominant cost lever.** The ~16.7k prompt replays every turn; a
   stable byte-identical prefix gets a large Azure discount. **Never interpolate per-request
   data into the system prompt** — put it in `runtimeContext`.
5. **Don't trust doc figures over the code.** "41.5k tokens", "10 built-in tools", "gpt-4o"
   were all wrong in earlier versions of this file.

---

## 10. Known open items

- **Progress indicator during partner search.** The bubble is empty for 30–60s while the tool
  runs; it reads as a hang. `ChatBody` shows the typing dots only while `status === "submitted"`.
  Keep them visible while streaming-with-no-text (ideally "Suche passende Partner …").
- **Service 2 is not locked down.** The proxy forwards to `PARTNER_AGENT_HOST` with no shared
  secret. Add a Firewall rule / shared-secret header / Deployment Protection before going public.
- **Secrets committed in the repo-root `.mcp.json`** (LangSmith + Stitch). Rotate and move to env.
- **Prompt V3 written but NOT deployed** (`agent/feedback/SYSTEM_PROMPT_V3.md`, 646 lines vs
  the live 1,384). Deploy = replace `instructions.md`, then re-run evals.
- **Known KB factual errors unfixed** — 9 issues in `agent/feedback/FEEDBACK-ANALYSIS.md`.
- **Production-readiness review** (`docs/PRODUCTION-READINESS-REVIEW.md`) has an open
  🔴/🟠 checklist: AI Gateway spend cap, distributed rate limiting, streaming-route timeout.
- **Contact form has no email fallback** — a Salesforce outage loses the lead (payload shape
  is logged, values are not). `nodemailer` + `SMTP_*` not wired.

---

## 11. Conventions to keep

- Edit `agent/instructions.md` for behaviour; validate through the eval loop; never bypass the
  feedback history in `agent/feedback/`.
- Keep the FAQ agent **tool-free**; keep LangSmith **EU-only / no-op-without-a-key /
  hooks-never-throw**.
- Widget visuals follow `docs/design/WIDGET-DESIGN-GUIDELINES.md` (green = AI action, orange =
  human hand-off, Outfit + Inter).
- Never commit `.env.local` or a real key.
- When searching the repo, exclude `.eve/`, `.next/`, `.output/`, `node_modules/` — they hold
  duplicate dev-host snapshots of the source.

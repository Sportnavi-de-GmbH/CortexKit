# Partner Agent Menu Option — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the Sportnavi Partner Recommendation agent as a third option ("Partner finden") in the Navio Plus menu, working end-to-end in the dev console.

**Architecture:** The partner agent stays its own separate service. The KB app (`kb-agent-langsmith-starter`) adds a same-origin proxy at `/api/partner/*` that forwards to `PARTNER_AGENT_HOST`, so the widget reaches the partner agent via `useEveAgent({ host: "/api/partner" })` while staying same-origin (reusing consent/BotID, no CORS). The widget's menu gains a third card and a new partner chat screen that reuses the existing chat components with different copy.

**Tech Stack:** Next.js 15 (App Router, `runtime = "nodejs"`), React 19, `eve@0.25.x` (`useEveAgent` from `eve/react`), TypeScript, Vitest, Tailwind v4, lucide-react.

**Full design spec:** [`docs/superpowers/specs/2026-08-03-partner-agent-menu-option-design.md`](../specs/2026-08-03-partner-agent-menu-option-design.md)

## Global Constraints

- All paths below are relative to `kb-agent-langsmith-starter/`. The `@/` import alias maps to that project root (matches existing `@/lib/contact/schema`).
- **Palette rule** (`app/globals.css`): `--brand-green` = the single call-to-action / AI-chat color; `--brand-orange` = human-handoff attention. **Do not introduce a new brand color.** Both chat options (FAQ + Partner) use `accent="green"`; only the contact card is orange.
- **Proxy is not an open proxy:** only forward paths beginning with `eve/`. When `PARTNER_AGENT_HOST` is unset, the proxy returns **503** and the KB widget keeps working.
- **`useEveAgent` is lazy:** no session/network until the first `send()`. Mounting the partner agent must not break the KB widget when no partner host is configured.
- **Commits stage only the files named in each task** (`git add <exact paths>`). The working tree contains unrelated uncommitted changes from a prior task — never `git add -A`.
- `npm run typecheck` and `npm test` must pass at the end of every task.

---

### Task 1: Same-origin partner proxy

**Files:**
- Create: `lib/partner-proxy.ts`
- Create: `app/api/partner/[...path]/route.ts`
- Test: `tests/partner-proxy.test.ts`

**Interfaces:**
- Produces:
  - `isForwardablePath(pathSegments: string[]): boolean`
  - `proxyToPartner(req: Request, pathSegments: string[], deps?: { host?: string; fetchImpl?: typeof fetch }): Promise<Response>`
- Consumes: nothing from other tasks. Task 2 consumes the route at `/api/partner/*` (no code import).

- [ ] **Step 1: Write the failing test**

Create `tests/partner-proxy.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { proxyToPartner, isForwardablePath } from "../lib/partner-proxy";

describe("isForwardablePath", () => {
  it("allows eve routes", () => {
    expect(isForwardablePath(["eve", "v1", "session"])).toBe(true);
    expect(isForwardablePath(["eve"])).toBe(true);
  });
  it("rejects non-eve paths", () => {
    expect(isForwardablePath(["admin"])).toBe(false);
    expect(isForwardablePath(["..", "etc", "passwd"])).toBe(false);
  });
});

describe("proxyToPartner", () => {
  const req = (method: string, url = "http://localhost/api/partner/eve/v1/session") =>
    new Request(url, method === "POST" ? { method, body: "{}" } : { method });

  it("returns 503 when no host is configured", async () => {
    const res = await proxyToPartner(req("GET"), ["eve", "v1", "session"], { host: "" });
    expect(res.status).toBe(503);
  });

  it("returns 404 for non-eve paths", async () => {
    const res = await proxyToPartner(
      req("GET", "http://localhost/api/partner/admin"),
      ["admin"],
      { host: "http://partner.local" },
    );
    expect(res.status).toBe(404);
  });

  it("forwards eve requests to the partner host and streams the upstream body", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("data: hi\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    ) as unknown as typeof fetch;

    const res = await proxyToPartner(req("POST"), ["eve", "v1", "session"], {
      host: "http://partner.local",
      fetchImpl,
    });

    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://partner.local/eve/v1/session",
      expect.objectContaining({ method: "POST" }),
    );
    expect(await res.text()).toBe("data: hi\n\n");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/partner-proxy.test.ts`
Expected: FAIL — cannot resolve `../lib/partner-proxy`.

- [ ] **Step 3: Implement the proxy library**

Create `lib/partner-proxy.ts`:

```ts
// Core logic for the /api/partner/* same-origin proxy — pure and testable
// (host + fetch injectable). The route handler in
// app/api/partner/[...path]/route.ts is a thin wrapper over this.
//
// WHY a proxy: the Partner Recommendation agent runs as a SEPARATE service/deploy.
// Proxying keeps the browser SAME-ORIGIN with the KB app, so the widget reuses the
// existing consent/BotID path and needs no CORS. Unset PARTNER_AGENT_HOST ⇒ 503, so
// the KB widget still works with no partner host configured.

// Hop-by-hop / host headers we must not forward (fetch recomputes length/encoding).
const STRIP = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
]);

export interface ProxyDeps {
  /** Defaults to process.env.PARTNER_AGENT_HOST. */
  host?: string;
  /** Defaults to global fetch (injectable for tests). */
  fetchImpl?: typeof fetch;
}

/** Only eve's own routes may be forwarded — this is NOT an open proxy. */
export function isForwardablePath(pathSegments: string[]): boolean {
  const path = pathSegments.join("/");
  return path === "eve" || path.startsWith("eve/");
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function proxyToPartner(
  req: Request,
  pathSegments: string[],
  deps: ProxyDeps = {},
): Promise<Response> {
  const host = (deps.host ?? process.env.PARTNER_AGENT_HOST ?? "").trim().replace(/\/+$/, "");
  const doFetch = deps.fetchImpl ?? fetch;

  if (!host) return json({ detail: "Partner agent not configured." }, 503);
  if (!isForwardablePath(pathSegments)) return json({ detail: "Not found." }, 404);

  const search = new URL(req.url).search;
  const target = `${host}/${pathSegments.join("/")}${search}`;

  const headers = new Headers();
  for (const [k, v] of req.headers) {
    if (!STRIP.has(k.toLowerCase())) headers.set(k, v);
  }

  const init: RequestInit = { method: req.method, headers, redirect: "manual" };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await req.arrayBuffer();
  }

  let upstream: Response;
  try {
    upstream = await doFetch(target, init);
  } catch (e) {
    return json({ detail: `Upstream unreachable: ${(e as Error).message}` }, 502);
  }

  // Stream the body straight back (SSE for the eve stream). Preserve status; copy
  // headers minus hop-by-hop ones.
  const respHeaders = new Headers();
  for (const [k, v] of upstream.headers) {
    if (!STRIP.has(k.toLowerCase())) respHeaders.set(k, v);
  }
  return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/partner-proxy.test.ts`
Expected: PASS (5 assertions across 3 `it` blocks).

- [ ] **Step 5: Create the route handler**

Create `app/api/partner/[...path]/route.ts`:

```ts
// Same-origin proxy: /api/partner/eve/v1/* → ${PARTNER_AGENT_HOST}/eve/v1/*
// Thin wrapper over lib/partner-proxy. force-dynamic + nodejs runtime so eve's
// text/event-stream responses stream through unbuffered.

import { proxyToPartner } from "@/lib/partner-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ path: string[] }> };

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  return proxyToPartner(req, (await ctx.params).path);
}

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  return proxyToPartner(req, (await ctx.params).path);
}
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add lib/partner-proxy.ts "app/api/partner/[...path]/route.ts" tests/partner-proxy.test.ts
git commit -m "feat(widget): add same-origin proxy to the partner agent host"
```

---

### Task 2: Menu option + partner chat screen

**Files:**
- Modify: `components/navio/NavioMenu.tsx`
- Modify: `components/navio/NavioWidget.tsx`
- Modify: `app/widget/page.tsx`

**Interfaces:**
- Consumes: the `/api/partner/*` route from Task 1 (via `useEveAgent({ host: "/api/partner" })`).
- Produces (component contracts other files in this task rely on):
  - `NavioMenu` props: `{ onSelectFaq: () => void; onSelectPartner: () => void; onSelectContact: () => void }`
  - `NavioWidget` props: `{ faqAgent: Agent; partnerAgent: Agent }` (was `{ agent: Agent }`)

> Intermediate steps in this task leave the type-checker red until the last edit; the gate is the typecheck at Step 7. Make the edits in order.

- [ ] **Step 1: Add the third menu card**

In `components/navio/NavioMenu.tsx`:

Change the import (add `MapPin`):

```ts
import { ArrowRight, Bot, Mail, MapPin } from "lucide-react";
```

Change the component signature to accept `onSelectPartner`:

```ts
export function NavioMenu({
  onSelectFaq,
  onSelectPartner,
  onSelectContact,
}: {
  onSelectFaq: () => void;
  onSelectPartner: () => void;
  onSelectContact: () => void;
}) {
```

Insert the partner card between the FAQ card and the Kontaktformular card (after the `onClick={onSelectFaq}` `OptionCard` closes, before the `Mail` `OptionCard`):

```tsx
        <OptionCard
          icon={<MapPin size={24} strokeWidth={1.75} />}
          title="Partner finden"
          body="Finde Studios & Kurse in deiner Nähe – sag einfach Stadt und Sportart."
          accent="green"
          onClick={onSelectPartner}
        />
```

- [ ] **Step 2: Extend the Screen model and header in NavioWidget**

In `components/navio/NavioWidget.tsx`:

Change the `Screen` union to include `partner`:

```ts
type Screen = "greeting" | "consent" | "menu" | "chat" | "partner" | "contact" | "info";
```

Add a `partner` row to the `HEADER` map, right after the `chat` row:

```ts
  chat: { title: "FAQ-Agent", subtitle: "Online", dot: true },
  partner: { title: "Partner-Finder", subtitle: "Online", dot: true },
  contact: { title: "Kontakt aufnehmen", subtitle: "Antwort in 1–2 Werktagen", dot: false },
```

- [ ] **Step 3: Add partner chat copy + per-screen config**

In `components/navio/NavioWidget.tsx`, immediately after the `GREETING_EN` constant, add:

```ts
const PARTNER_GREETING_DE =
  "Sag mir, wo und was du trainieren willst – z. B. 'Yoga in Bochum' 📍\nIch zeige dir passende Sportnavi-Partner in deiner Nähe.";
const PARTNER_GREETING_EN =
  "Tell me where and what you want to train — e.g. 'Yoga in Bochum' 📍\nI'll show you matching Sportnavi partners near you.";
const PARTNER_QUICK_REPLIES = [
  "Yoga in Bochum",
  "Klettern für Anfänger",
  "Fitnessstudio in Bielefeld",
  "Reha-Sport in meiner Nähe",
];

// Per-chat-screen copy so the FAQ and Partner screens reuse ChatBody/InputBar.
const CHAT_CFG = {
  chat: {
    greetingDe: GREETING_DE,
    greetingEn: GREETING_EN,
    quickReplies: QUICK_REPLIES,
    placeholder: "Frage Navio …",
  },
  partner: {
    greetingDe: PARTNER_GREETING_DE,
    greetingEn: PARTNER_GREETING_EN,
    quickReplies: PARTNER_QUICK_REPLIES,
    placeholder: "Stadt & Sportart, z. B. 'Yoga in Bochum' …",
  },
} as const;
```

- [ ] **Step 4: Switch NavioWidget to two agents**

In `components/navio/NavioWidget.tsx`, replace the component opening (signature through the `send` function) with:

```tsx
export function NavioWidget({
  faqAgent,
  partnerAgent,
}: {
  faqAgent: Agent;
  partnerAgent: Agent;
}) {
  const { theme, toggle } = useNavioTheme();
  const [screen, setScreen] = useState<Screen>("greeting");
  const [declined, setDeclined] = useState(false);
  const [draft, setDraft] = useState("");

  // The two chat screens ("chat" = FAQ, "partner" = finder) each drive their own eve
  // agent; every message/status/reset below targets whichever screen is active.
  const activeAgent = screen === "partner" ? partnerAgent : faqAgent;
  const isChatScreen = screen === "chat" || screen === "partner";
  const cfg = screen === "partner" ? CHAT_CFG.partner : CHAT_CFG.chat;

  const isBusy = activeAgent.status === "submitted" || activeAgent.status === "streaming";
  const messages = activeAgent.data.messages;

  function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || isBusy || !isChatScreen) return;
    setDraft("");
    void activeAgent.send({ message: trimmed });
  }
```

Then update `showBack`:

```ts
  const showBack = isChatScreen || screen === "contact" || screen === "info";
```

- [ ] **Step 5: Route the header reset, menu, chat body, and input bar through the active agent**

In `components/navio/NavioWidget.tsx`:

Replace the reset-button block:

```tsx
        {isChatScreen && (
          <HeaderBtn label="Chat zurücksetzen" onClick={() => activeAgent.reset()}>
            <RotateCcw size={16} strokeWidth={1.75} />
          </HeaderBtn>
        )}
```

Replace the menu render:

```tsx
      {screen === "menu" && (
        <NavioMenu
          onSelectFaq={() => setScreen("chat")}
          onSelectPartner={() => setScreen("partner")}
          onSelectContact={() => setScreen("contact")}
        />
      )}
```

Replace the chat-body render:

```tsx
      {isChatScreen && (
        <ChatBody
          agent={activeAgent}
          isBusy={isBusy}
          messages={messages}
          onQuickReply={send}
          greetingDe={cfg.greetingDe}
          greetingEn={cfg.greetingEn}
          quickReplies={cfg.quickReplies}
        />
      )}
```

Replace the input-bar render:

```tsx
      {isChatScreen && (
        <InputBar
          draft={draft}
          setDraft={setDraft}
          onSend={() => send(draft)}
          disabled={isBusy}
          placeholder={cfg.placeholder}
        />
      )}
```

- [ ] **Step 6: Parametrize ChatBody's greeting and quick replies**

In `components/navio/NavioWidget.tsx`, change the `ChatBody` signature:

```tsx
function ChatBody({
  agent,
  isBusy,
  messages,
  onQuickReply,
  greetingDe,
  greetingEn,
  quickReplies,
}: {
  agent: Agent;
  isBusy: boolean;
  messages: EveMessageData["messages"];
  onQuickReply: (text: string) => void;
  greetingDe: string;
  greetingEn: string;
  quickReplies: readonly string[];
}) {
```

Inside `ChatBody`, replace the static greeting bubble:

```tsx
      <BotBubble>
        <p className="whitespace-pre-wrap">{greetingDe}</p>
        <p className="mt-2 whitespace-pre-wrap text-(--fg-subtle)">{greetingEn}</p>
      </BotBubble>
```

And replace the quick-replies map opening line `{QUICK_REPLIES.map((q) => (` with:

```tsx
          {quickReplies.map((q) => (
```

- [ ] **Step 7: Wire both agents in the widget page**

In `app/widget/page.tsx`, replace the `WidgetPage` component:

```tsx
export default function WidgetPage() {
  const faqAgent = useEveAgent();
  // The partner finder runs as a separate service; the KB app proxies /api/partner/*
  // to it (see app/api/partner/[...path]/route.ts). Lazy — no session until first send.
  const partnerAgent = useEveAgent({ host: "/api/partner" });
  useBotId();
  useEffect(ensureVisitorId, []);

  return <NavioWidget faqAgent={faqAgent} partnerAgent={partnerAgent} />;
}
```

- [ ] **Step 8: Typecheck and run the full test suite**

Run: `npm run typecheck`
Expected: exits 0 (confirms the `NavioWidget` prop change, the new `Screen` variant, and the `NavioMenu`/`ChatBody` signatures all line up).

Run: `npm test`
Expected: all suites pass, including `tests/partner-proxy.test.ts` from Task 1.

- [ ] **Step 9: Commit**

```bash
git add components/navio/NavioMenu.tsx components/navio/NavioWidget.tsx app/widget/page.tsx
git commit -m "feat(widget): add Partner finder as a third Navio menu option"
```

---

### Task 3: Config + two-service dev runbook

**Files:**
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:**
- Consumes: `PARTNER_AGENT_HOST` (read by `lib/partner-proxy.ts` from Task 1).
- Produces: documentation only.

- [ ] **Step 1: Document the env var**

In `.env.example`, add this block after the `--- Public widget security ---` section (before `--- LangSmith (EU) ---`):

```bash
# --- Partner agent menu option (proxy target) ---
# The "Partner finden" menu option proxies /api/partner/* to the Partner Recommendation
# agent, which runs as a SEPARATE service/deploy. Point this at that project's eve host.
# UNSET = the option is effectively disabled (the proxy returns 503) and the KB widget
# still works. Local demo: run that project on its own port and set:
PARTNER_AGENT_HOST=http://localhost:3001
```

- [ ] **Step 2: Add the dev runbook to the README**

Append this section to the end of `README.md`:

```markdown
## Local demo — Partner finder in the menu

The "Partner finden" menu option talks to the **Partner Recommendation agent**, which
lives in the separate `SportnaviPartnerRecomandationBot` project. Run both locally:

1. **Start the partner agent** (its own repo) on its own port, with its own `.env.local`
   (Azure + Supabase + embeddings):
   ```bash
   # in SportnaviPartnerRecomandationBot/partner-recommendation-agent
   npm run dev:ui -- -p 3001
   ```
2. **Start this app** with the proxy target set:
   ```bash
   # in kb-agent-langsmith-starter
   PARTNER_AGENT_HOST=http://localhost:3001 npm run dev:ui
   ```
3. Open the widget, accept consent, choose **Partner finden**, and ask e.g. *"Yoga in
   Bochum"*. Requests flow: widget → `/api/partner/eve/v1/*` (this app) → the partner host.

If `PARTNER_AGENT_HOST` is unset, the proxy returns 503 and only the FAQ + contact
options are usable.
```

- [ ] **Step 3: Verify docs render / no broken build**

Run: `npm run typecheck`
Expected: exits 0 (docs-only change; confirms nothing else regressed).

- [ ] **Step 4: Commit**

```bash
git add .env.example README.md
git commit -m "docs(widget): document PARTNER_AGENT_HOST and the two-service dev demo"
```

---

### Task 4: Manual dev-console verification

**Files:** none (manual QA).

- [ ] **Step 1: Start both services** per the README runbook (partner agent on `:3001`, KB app with `PARTNER_AGENT_HOST` set).

- [ ] **Step 2: Verify the menu** — open the widget, accept consent. The menu shows **three** cards: FAQ-Agent (green, bot), Partner finden (green, map pin), Kontaktformular (orange, mail).

- [ ] **Step 3: Verify the partner chat** — click **Partner finden**. Header reads "Partner-Finder". Send "Yoga in Bochum"; a streamed answer with real partners appears. Back arrow returns to the menu; re-opening shows the conversation preserved. The reset button clears it.

- [ ] **Step 4: Verify no regression** — the FAQ-Agent chat and the Kontaktformular still work exactly as before. Confirm the FAQ chat streams while the partner agent is also mounted.

- [ ] **Step 5: Verify the off switch** — stop the partner service (or unset `PARTNER_AGENT_HOST`) and confirm the KB widget still loads and the FAQ/contact options work; the partner chat surfaces the error state rather than crashing the widget.

---

## Self-Review

- **Spec coverage:** Unit A (proxy) → Task 1; Unit B (dual-agent wiring) → Task 2 Step 7; Unit C (menu card + partner screen + ChatBody parametrization) → Task 2 Steps 1–6; Unit D (config + runbook) → Task 3; Testing (proxy unit test, typecheck, manual) → Task 1 Steps 1–4, Task 2 Step 8, Task 4. All spec sections mapped.
- **Placeholder scan:** no TBD/TODO; every code step shows complete code.
- **Type consistency:** `proxyToPartner`/`isForwardablePath` signatures match test and route usage; `NavioWidget` props `{ faqAgent, partnerAgent }` are produced in `app/widget/page.tsx` and consumed in `NavioWidget`; `NavioMenu` `onSelectPartner` is defined and passed; `CHAT_CFG.chat`/`CHAT_CFG.partner` keys match the `screen === "partner" ? ... : ...` selection; `ChatBody`'s new `greetingDe/greetingEn/quickReplies` props match the caller in Step 5.

# Deploy & Secure Navio — the complete guide (no coding required)

This is the **one** guide for putting Navio live on the internet safely. It is written for a
**non-technical owner**: every technical word is explained the first time it appears, and every
Vercel step is spelled out as exact clicks. Follow the sections in order and do not move past a
✅ **Checkpoint** until it passes.

> **This document is the single source of truth for Navio's firewall rules and security
> settings.** Other files ([`VERCEL-RUNBOOK.md`](VERCEL-RUNBOOK.md) for the command-line version,
> [`PUBLIC-WIDGET-DEPLOYMENT.md`](PUBLIC-WIDGET-DEPLOYMENT.md) for the deeper "why") point back
> here for the rules themselves.

**A few words you'll see a lot:**

- **Vercel** — the hosting company that runs your website and chatbot. You manage everything from
  its website, [vercel.com](https://vercel.com) (the "**dashboard**").
- **Deploy** — to publish your code so it's live on the internet.
- **Environment variable** — a saved setting (like a password or a web address) that the app
  reads when it runs. You type these into Vercel; they are **not** in the public code.
- **Endpoint** — a single web address the app answers on (for example, the address the chat sends
  each message to).
- **Origin** — the website an action comes *from* (for example `https://sportnavi.de`). Browsers
  attach this automatically and honestly, which is what lets us allow our site and block others.

---

## §1 — Security architecture (understand this first)

You don't need to build anything in this section — it explains **how Navio is put together and
why it's safe**, so the later steps make sense.

### What you are running: two services

Navio is **two separate programs** ("services") that you deploy as **two Vercel projects** — but
**both live in the same GitHub repository (`CortexKit`)**. They are told apart by their **Root
Directory** (the sub-folder Vercel builds), not by being in different repositories:

| # | Project | Lives in (one repo: `CortexKit`) | What it is | Who is allowed to reach it |
|---|---|---|---|---|
| 1 | **navio-widget** (public) | folder `kb-agent-langsmith-starter` | The chat widget your visitors see, **plus** the FAQ/KB agent that answers product questions. | The public — but only from **sportnavi.de**. |
| 2 | **navio-partner** (internal) | folder `SportnaviPartnerRecomandationBot/partner-recommendation-agent` | The Partner agent that finds studios/courses near a city. | **Only project 1**, never the public. |

The **FAQ agent lives in the widget folder**. The **Partner agent is a separate program in a
separate folder** (its own database, its own release schedule) — so it becomes its own Vercel
project, deployed from the **same repository** with a different Root Directory. You do **not** need
a second GitHub repository.

> ℹ️ There is an older, standalone `SportnaviPartnerRecomandationBot` repository on GitHub. It is
> **not** used by this setup and is out of date — the Partner agent's live code is the folder
> inside `CortexKit`. Ignore that separate repo; deploy everything from `CortexKit`.

### The request flow — how a message travels

```
  Visitor's browser (on sportnavi.de)
        │  types a message in the widget
        ▼
  ① Navio widget  (project 1, public)  https://chat.sportnavi.de
        │
        ├─ FAQ question ──────────────► FAQ agent (inside project 1)  → answer
        │
        └─ "find a studio" ──► ② Proxy (inside project 1, /api/partner)
                                     │  adds a secret password
                                     ▼
                               ③ Partner agent (project 2, internal)  → answer
```

In plain words: **the browser only ever talks to one address** — project 1. Anything about the
product, rules, or money is answered by the FAQ agent right there. Anything about *finding a place
to train* is quietly relayed by project 1 to project 2 and the answer comes back the same way.

### Why the two agents are wired differently (and why that's correct)

- The **FAQ agent needs no relay** — it lives inside project 1, so the browser reaches it directly.
- The **Partner agent is a different project on a different address.** If the browser called it
  directly, that call would (a) skip *all* of project 1's protections and (b) trigger browser
  "cross-site" security friction. So project 1 includes a small **proxy** — a relay that takes the
  browser's request and forwards it to project 2 on the server side.

> **Proxy** = a relay that sits in the middle. The browser talks to project 1's proxy as if the
> Partner agent were part of the same site; the proxy talks to project 2 for it. This keeps the
> browser on **one origin**, so the consent gate, the origin lock, bot protection, and your
> firewall rules all still apply to partner requests too.

### When you need "internal authentication," and which kind to use

The public front door (project 1) is guarded by Vercel's firewall, bot protection, and rate
limits (§3). But those guard the **public**. They **cannot** prove that a request arriving at the
**private** project 2 really came from your proxy and not from a stranger who found its address.
The reason: Vercel's servers don't have one fixed internet address you could put on an allow-list,
and any header on a server-to-server call can be faked. So project 2 needs its **own** check.

The options, and the recommendation:

| Approach | What it is | Verdict for Navio |
|---|---|---|
| **Shared secret** | One long random password that project 1 sends and project 2 checks. | ✅ **Recommended.** One value in two projects. Works the same in production, preview, and on your laptop. If it's wrong, you get a clear "401" and know exactly what's broken. |
| **API key** | Same idea as a shared secret, usually issued by a third party. | Same as a shared secret here; no third party is involved, so nothing extra to gain. |
| **Bearer token (JWT)** | A signed token that expires and carries claims. | Overkill for one caller talking to one service. More moving parts, more ways to misconfigure. |
| **Vercel-native (OIDC / Deployment Protection)** | Let Vercel's platform identity gate the service. | Works, but the identity string changes if you rename the project, and it's awkward on a local laptop. Kept as a documented fallback, not the default. |

**This is already built into Navio's code.** Project 1's proxy attaches the shared secret; project
2 verifies it and rejects everyone else. You only have to **set the same secret value in both
projects** (§2 and §5) — no coding.

> **401** = the standard "you are not allowed in" response. Seeing a 401 from project 2 when you
> forgot the secret is *correct* — it proves the lock works.

### How the backend is protected from direct access

Three things keep project 2 (and its data) private:

1. The **shared secret** above — the authoritative lock.
2. A **non-obvious address** for project 2 and, optionally, **Vercel Deployment Protection** so its
   internal console page isn't browsable (§10).
3. Project 2's own code now **redirects its console to a harmless health page in production**, so a
   stray visitor sees nothing useful.

✅ **Checkpoint (understanding):** you can explain, in a sentence, why the Partner agent uses a
proxy and the FAQ agent doesn't, and why project 2 still needs its own secret even with the
firewall on. If yes, continue.

---

## §2 — Deploy to Vercel, step by step (from zero)

You will deploy **project 2 first**, because project 1 needs project 2's web address.

### Before you touch Vercel — protect your secrets

Your code folder contains a file, `.mcp.json`, that holds real API keys. Confirm your ignore list
keeps private files out of the public code. They should already be listed:

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

Then **rotate** (replace) the LangSmith and Stitch keys that were once in that file — once a key
has lived in a shared repository, treat it as compromised and issue a fresh one from each provider.
(More on secrets in §5.)

### The pieces you'll need

- Access to the **one GitHub repository** where all the code lives: **`CortexKit`** (this is your
  Sportnavi organization's `CortexKit` repo — e.g. `Sportnavi-de-GmbH/CortexKit`). Both projects
  are deployed from this same repository. *(You do not need a separate Partner-agent repository.)*
- A **Vercel** account on the **Pro** plan (this guide assumes Pro; a Hobby fallback is in the
  appendix).
- The **environment-variable values** listed below (Azure keys, database keys, etc.).
- Access to **sportnavi.de's DNS** (its domain settings) for the custom-address step (§11).

> **GitHub / repository** = the online storage for the code. **Root Directory** = the sub-folder
> inside that repository that Vercel actually builds for a given project. **DNS** = the settings
> that point a web address like `chat.sportnavi.de` at the right server.

### Step 1 — Confirm the code is on GitHub

`CortexKit` is already on GitHub, and it **already contains both programs** (the widget folder and
the partner-agent folder). There is nothing to split out — you deploy both Vercel projects from
this single repository.

✅ **Checkpoint:** you can open your `CortexKit` repository on github.com and see **both** folders:
`kb-agent-langsmith-starter` and `SportnaviPartnerRecomandationBot/partner-recommendation-agent`.
Confirm `.mcp.json` / `.env.local` are **not** visible there.

### Step 2 — Import project 2 (Partner agent) first

1. On **vercel.com**, click **Add New… → Project**.
2. Import **`CortexKit`** (the same repository you'll use for project 1). First time only: click
   **Install** to connect Vercel to your GitHub and grant access.
3. **Root Directory** → **Edit** → choose **`SportnaviPartnerRecomandationBot/partner-recommendation-agent`**.
   **This is mandatory** — skip it (or pick the wrong folder) and every address returns "404 Not
   Found" because Vercel builds the wrong part of the repo.
4. Give this project a clear name, e.g. **`navio-partner`**, so you don't confuse it with project 1
   (which uses the *same* repository).
5. Open **Environment Variables** and add project 2's values (plain-language meaning in the table).
6. Click **Deploy**.

**Project 2 environment variables**

| Variable | What it is, in plain words |
|---|---|
| `AZURE_AI_CHATBOT_OPENAI_ENDPOINT` | The web address of your Azure OpenAI (the AI brain). |
| `AZURE_AI_CHATBOT_API_KEY` | The password for that AI. **Secret.** |
| `AZURE_AI_CHATBOT_DEPLOYMENT_NAME` | Which AI model to use (e.g. `gpt-4.1`). |
| `MEMORY_SUPABASE_URL` | The address of the partner **database**. |
| `MEMORY_SUPABASE_SERVICE_ROLE_KEY` | The database password. **Use the "service-role" key** — the ordinary key silently returns zero partners. **Secret.** |
| `EMBEDDING_API_URL` / `EMBEDDING_API_KEY` | The service that turns text into numbers so the agent can find *similar* studios. **The key is secret.** |
| **`PARTNER_PROXY_SECRET`** | ⬅ **The shared secret from §1.** A long random password. **It must be identical to project 1's `PARTNER_PROXY_SECRET`.** Generate one long random string now and keep it somewhere safe. **Secret.** |
| `SENTRY_*`, `LANGSMITH_*` | Optional error-tracking and tracing. Leave blank to skip. |

✅ **Checkpoint:** the build succeeds and you get an address like
`https://navio-partner.vercel.app`. **Copy this address — project 1 needs it.** (Opening it in a
browser now may show a login screen or a small health message; that's fine — it's meant to be
private.)

### Step 3 — Import project 1 (the widget)

You import the **same `CortexKit` repository a second time** — Vercel allows one repository to power
several projects, each with its own Root Directory.

1. **Add New… → Project** → import **`CortexKit`** again (yes, the same repo as project 2).
2. **Root Directory** → **Edit** → **`kb-agent-langsmith-starter`**. *(Mandatory — this is what makes
   this project the widget rather than the partner agent.)*
3. Name it e.g. **`navio-widget`** and leave the build settings at their defaults.
4. Add project 1's environment variables:

| Variable | What it is, in plain words |
|---|---|
| `AZURE_AI_CHATBOT_OPENAI_ENDPOINT` / `_API_KEY` / `_DEPLOYMENT_NAME` | Same AI settings as above (the FAQ agent's brain). The key is **secret**. |
| **`PARTNER_AGENT_HOST`** | ⬅ **Project 2's address from Step 2.** This is how the widget reaches the Partner agent. If it's missing, "Partner finden" returns a 503 error and the other two cards still work. |
| **`PARTNER_PROXY_SECRET`** | ⬅ **The exact same secret you set in project 2.** This is what the proxy sends to prove it's allowed. **Secret.** |
| **`WIDGET_FRAME_ANCESTORS`** | The list of websites allowed to **embed** the widget. Default already allows sportnavi.de (see §3). |
| `LANGSMITH_*` | Optional tracing (EU region). Leave blank to skip. |
| `SALESFORCE_*` | For the contact form. **Blank ⇒ the form runs in "simulate mode"** (it says success but saves nothing) — fine for testing. |

5. Click **Deploy**.

✅ **Checkpoint:** you get an address like `https://navio-widget.vercel.app`.

### Understanding Production, Preview, and Development

When you add an environment variable, Vercel asks which **environments** it applies to. In plain
terms:

- **Production** — the real, live site your visitors use. **Tick this for every variable above.**
- **Preview** — a temporary test copy Vercel makes for each code change, so you can try things
  before they go live. Ticking it too is convenient.
- **Development** — your own laptop. Not needed on Vercel; you set those in a local file.

Rule of thumb: tick **Production** and **Preview** for all of the variables above. The two
`PARTNER_PROXY_SECRET` entries must hold the **same value** in both projects.

### Step 4 — Test all three menu cards

Open `https://<project-1-address>/widget`, click **Mit Navio chatten → Zustimmen**, and confirm
the three cards:

- **FAQ-Agent** → ask *"Was ist Firmenfitness?"* → it answers.
- **Partner finden** → *"Yoga in Bochum"* → real studios come back. ⏱️ **Wait 30–60 seconds** —
  the bubble is empty while it searches; that's normal. A **503** means `PARTNER_AGENT_HOST` is
  wrong; a **401/empty Partner answer** means the two `PARTNER_PROXY_SECRET` values don't match.
- **Kontaktformular** → submits (simulate mode if Salesforce is blank).

✅ **Checkpoint:** **all three cards work.** This proves the shared secret is correct end to end.

---

## §3 — Vercel security configuration (the checklist)

Everything here is on **project 1** unless noted, done from the Vercel dashboard.

> **The golden rule of firewall changes: start in "Log," never in "Block."** Every rule below is
> first set to **Log** (it records who *would* be affected but blocks nobody), you review real
> traffic for a day, and *only then* switch it to blocking. This way you never accidentally lock
> out real visitors.

### 3a. Firewall Rules

A **firewall rule** is an "if this, then that" for incoming web traffic. Go to project 1 →
**Firewall** → **Custom Rules** → **New Rule**. Create each rule below, leave its action on
**Log**, **Save**, then **Publish** (top of the Firewall page). Vercel does **not** bill you for
traffic a rule blocks, and basic flood ("DDoS") protection is always on for free.

> **Rate limit** = a cap on how many requests one visitor can make in a time window (e.g. 20 per
> minute). **JA4** = a fingerprint of the visitor's connection, used alongside their IP address so
> the cap is harder to dodge. **Endpoint paths** below (like `/eve/v1/session`) are the internal
> addresses the widget uses.

#### How to enter a condition in the Vercel UI (read this once — it applies to every rule below)

In the **If** area of a rule, each condition is built from three parts plus (sometimes) a value:

1. **Parameter** — *what* to look at. You'll use **Request Path**, **Request Method**, and
   **Request Header**. ⚠️ **There is no "Origin" entry in the list** — `Origin` is an HTTP *header*,
   so you choose **Request Header** and a **Key** box appears where you type `Origin`.
2. **Operator** — *how* to compare. The ones used below are **Starts with**, **Equals**, **Exists**
   (for "the header is present" — needs **no value**, and it only appears **after** you type the
   Key), and **Is not any of** (compare against a list).
3. **Value** — what to match (leave empty for **Exists**).

Add more conditions in the same group with **＋ And**. Pick the rule's **action** at the bottom
(**Log** / **Deny** / **Rate Limit**); a **Rate Limit** action also asks for the **count**, the
**window** in seconds, and the **key** to count by (**IP**, or **IP + JA4**).

> Your account may label an operator slightly differently (e.g. **Is set** instead of **Exists**,
> or **Does not equal** for a single value). Pick the closest match — the meaning is what counts.

**Rule A — Allow only Sportnavi origins (the origin lock).** *Protects against: other websites
calling your chatbot's API to run up your bill.* Build it as **three conditions joined by AND**:

| # | Parameter | Key | Operator | Value |
|---|---|---|---|---|
| 1 | **Request Path** | — | **Starts with** | `/eve/v1/` |
| 2 | **Request Header** | `Origin` | **Exists** | *(leave empty)* |
| 3 | **Request Header** | `Origin` | **Is not any of** | `https://chat.sportnavi.de`, `https://www.sportnavi.de`, `https://sportnavi.de` |

Action: **Log** (later → **Deny**).

> 💡 **Couldn't find "Origin"?** That's expected — pick **Request Header** and type `Origin` in the
> **Key** box (conditions 2 and 3). The **Exists** operator shows up **only after** you've entered
> the Key.
>
> ⚠️ The **"Origin Exists"** condition (row 2) is deliberate: the live answer-stream and health
> checks legitimately send **no** Origin, and you must not block those. Without it, row 3 would also
> match empty-Origin requests and break streaming.
>
> ⚠️ **While you are still testing on the temporary `*.vercel.app` address (before §8a):** your own
> widget's Origin is `https://<project>.vercel.app`, which is *not* in the list — switching this
> rule to **Deny** now would block **your own widget**. Keep it on **Log** until the real
> `chat.sportnavi.de` address is live (or temporarily add the `*.vercel.app` origin to row 3's list
> while testing, and remove it afterwards).
>
> ℹ️ **The API routes `/api/partner/` and `/api/contact` are already origin-checked in the app's
> own code**, and rate-limited by Rule E — so Rule A can stay simple and cover just `/eve/v1/`. If
> you want the same edge-level origin lock on them too (optional hardening), duplicate Rule A twice
> more with row 1 changed to Path **Starts with** `/api/partner/` and Path **Equals** `/api/contact`.

**Rule B — Limit starting a chat.** *Protects against: a script opening thousands of chats to burn
AI credits.*
- If **Method** `POST` **AND Path** *equals* `/eve/v1/session`
- Then: **Rate Limit** → **20 per 60s**, keyed by **IP + JA4** → **Log** (later → **429**)

**Rule C — Limit messages.** *Protects against: message-flooding within a chat.*
- If **Method** `POST` **AND Path** *starts with* `/eve/v1/session/`
- Then: **Rate Limit** → **60 per 60s** by **IP** → **Log** (later → **429**)

**Rule D — Light limit on the live answer stream.** *Keep this generous — reconnects are normal.*
- If **Method** `GET` **AND Path** *starts with* `/eve/v1/session/`
- Then: **Rate Limit** → **120 per 60s** by **IP** → **Log** (later → **429**)

**Rule E — Protect the partner search and the contact form.**
- If **Path** *starts with* `/api/partner/` → **Rate Limit 60 per 60s** by IP → **Log**
- If **Method** `POST` **AND Path** *equals* `/api/contact` → **Rate Limit 15 per 60s** by IP →
  **Log**

> ⚠️ Do **not** set a tight limit on the partner **stream** — one search holds the connection for
> 30–60 seconds and visitors may reconnect. The contact form has a small built-in limiter, but it
> only counts per server copy, so **this firewall rule is the real control.**

> **429** = "too many requests, slow down" — the polite response a rate limit returns.

**Rolling out safely:** Publish all rules in **Log**. Let real traffic run for about a day. Open
**Firewall → Traffic** and confirm **no genuine visitors** are being matched. Then edit each rule
from **Log** to **Deny** (Rule A) or **429** (Rules B–E) and **Publish** again. Keep that Traffic
page handy for the first day in case you need to switch a rule back to **Log**.

✅ **Checkpoint:** all rules show **Active** in **Log**; the Traffic page shows matches when you
deliberately test from another website.

### 3b. Bot Protection

**BotID** is Vercel's invisible bot check — it decides whether a visitor is a real person or an
automated script, with no puzzle for the user to solve.

1. In project 1's settings, enable **BotID Deep Analysis** (this is the stronger, machine-learning
   mode included with **Pro**).
2. In **Environment Variables**, set **both** `BOTID_ENABLED` = `true` **and**
   `NEXT_PUBLIC_BOTID_ENABLED` = `true`, then **Redeploy**. (The code that wires BotID in is
   already in place — you only flip these switches.)

*Recommended settings:* leave it on for the chat, which is where the cost is. It protects the
"start a chat" step. *How not to block real users:* BotID is invisible and tuned to allow humans —
there is no captcha and nothing for a genuine visitor to do.

✅ **Checkpoint:** the widget opens with no visible puzzle; a scripted (non-browser) call to
`/eve/v1/session` is turned away.

### 3c. Rate Limiting — recap of what to protect

You already created these in Rules B–E. In summary, an AI chatbot needs limits on: **starting
chats** (most expensive), **sending messages**, the **partner search**, and the **contact form**.
Generous limits (like the numbers above) stop spam and cost attacks without annoying real users.
The firewall counts *per region*, so treat it as **shaping** traffic — the true cost ceiling is the
spend cap in §6.

### 3d. Domain and Origin Security — "only works on sportnavi.de"

This is your headline requirement, and it's enforced by **two independent layers**. A copied
widget fails **both**:

1. **Embedding lock (`frame-ancestors`).** The widget page tells browsers *which sites may show it
   inside them*. The setting is `WIDGET_FRAME_ANCESTORS`; its default is
   `'self' https://www.sportnavi.de https://sportnavi.de`. If someone copies the embed code onto
   `evil.com`, the visitor's **browser itself refuses to display the widget** — nothing you have
   to configure per attacker.

   > **CSP / frame-ancestors** = a browser rule, sent by your site, listing who is allowed to put
   > your page inside a frame on their site. Everyone else is refused by the browser.

2. **API origin lock (Firewall Rule A).** Even if someone copied the widget's behaviour and called
   your API directly from `evil.com`, the visitor's browser attaches `Origin: https://evil.com`,
   which isn't on your allow-list, so **Rule A denies it**. Browsers can't fake the Origin, so this
   holds for any real visitor on any other site.

To allow an *additional* legitimate site later, add its address to **both**
`WIDGET_FRAME_ANCESTORS` **and** Rule A's list, then redeploy. No code change.

✅ **Checkpoint:** you understand that embedding is blocked by the browser (layer 1) and direct API
calls are blocked by the firewall (layer 2).

---

## §4 — AI agent security (per agent)

### FAQ / KB Agent (inside project 1)

- **Direct-access protection:** every call passes the origin lock, the size cap, and (on
  chat-start) BotID before the AI is ever contacted.
- **Prompt-abuse protection:** the FAQ agent has **zero tools** by design — it can only read from
  its built-in knowledge and reply as text. It can't run commands, browse the web, or touch a
  database, so a malicious message has nothing to hijack.
- **Token limits:** each conversation has a built-in ceiling on how much text it can consume
  (settings `NAVIO_MAX_INPUT_TOKENS_PER_SESSION` / `_OUTPUT_`), so a single abusive chat can't run
  forever. There is also a size cap on each message (`NAVIO_MAX_REQUEST_BYTES`, ~16 KB) that
  rejects giant pastes before they cost anything.
- **Rate limits:** Rules B, C, D above.

> **Token** = a chunk of text (roughly ¾ of a word) that the AI is billed per. Limiting tokens =
> limiting cost.

### Partner Agent (project 2)

- **Secure communication between the services:** project 1's proxy attaches the **shared secret**
  as a standard `Authorization` password on every forwarded request; project 2 verifies it and
  rejects anything without it. The secret lives **only on the servers** (both projects'
  environment variables) — it is never in the browser or the public code.
- **Does it need a proxy? Yes** — because it's a separate project on a separate address, the proxy
  is what keeps the browser same-origin and lets project 1's protections cover partner requests
  (see §1).
- **Protection from public access:** the shared secret (authoritative) + a non-obvious address +
  the production console redirect (§10). Without the correct secret, project 2 answers **401** to
  everyone.
- **Using the shared secret correctly:** one long random value, identical in both projects, stored
  only as an environment variable, rotated by changing it in both places and redeploying (§5).
  Never paste it into a message, a ticket, or the code.

**The full journey again, with the lock shown:**

```
Visitor → Widget (project 1) → Proxy (project 1, adds the secret) → Partner agent (project 2, checks the secret) → answer
```

✅ **Checkpoint:** with the secret set in both projects, "Partner finden" works; if you clear it in
project 2 and redeploy, the Partner card stops working (401) while FAQ and Contact still work —
proof the lock is real.

---

## §5 — Secrets and tokens

> **Secret** = any value that would let someone impersonate you or spend your money: API keys,
> database passwords, the shared secret. Treat all of them like house keys.

**Which secrets Navio uses, and where they live:**

| Secret | Lives in | Never put it in… |
|---|---|---|
| Azure AI key (`AZURE_AI_CHATBOT_API_KEY`) | Both projects' **Vercel Environment Variables** | the browser, the public code, a chat message |
| Database key (`MEMORY_SUPABASE_SERVICE_ROLE_KEY`) | Project 2's env vars | anywhere public |
| Embedding key (`EMBEDDING_API_KEY`) | Project 2's env vars | anywhere public |
| **Shared secret (`PARTNER_PROXY_SECRET`)** | **Both** projects' env vars, identical value | the browser, the code, a ticket |
| LangSmith / Stitch / Salesforce keys | The relevant project's env vars | the repo's `.mcp.json` in public |

**The rule that matters most:** anything named `NEXT_PUBLIC_...` is *deliberately* visible in the
browser (for Navio that's only the two BotID on/off switches and some public link URLs — never a
real secret). **Everything else must stay server-side only.** Navio is built this way already: the
Azure key, database key, and shared secret are only ever read on the server.

**How the shared secret ("Bearer/Basic" server-to-server auth) works, in plain words:** project 1
holds the password, stamps it onto each partner request as a standard `Authorization` header, and
project 2 checks it with a **constant-time** comparison (a method that doesn't leak the answer by
timing). The browser never sees it because the stamping happens on project 1's server, after the
browser's request arrives.

**How to rotate (replace) a secret safely:**
1. Generate a new long random value.
2. Update it in **both** projects' Environment Variables (for the shared secret, both must match).
3. **Redeploy** both projects (environment changes only take effect on a redeploy).
4. Retire the old value.

**Avoiding leaks:** keep `.mcp.json` and `.env.local` out of GitHub (they already are); rotate any
key that was ever committed or shared (do the LangSmith + Stitch keys **before** launch); never
paste secrets into chats or screenshots.

✅ **Checkpoint:** no real secret is set as `NEXT_PUBLIC_...`; the shared secret matches in both
projects; the old `.mcp.json` keys have been replaced.

---

## §6 — Cost protection (don't get a surprise bill)

The AI charges per token, so an attacker's real goal may be to make you spend. Four layers stop
that:

1. **Per-conversation token limits** — already set in the code (`NAVIO_MAX_*`), so one chat can't
   consume unlimited text.
2. **Request limits (the firewall)** — Rules B–E cap how often anyone can start chats, send
   messages, or search.
3. **The real ceiling: Azure's own limit.** In the **Azure Portal** (not Vercel):
   - Open your Azure OpenAI resource → **Model deployments → your model → Edit** → set a
     **Tokens-Per-Minute (TPM)** limit. This is a hard cap on how fast tokens can be spent.
   - Open **Cost Management → Budgets → + Add** → set a monthly budget with an **email alert**.

   > ⚠️ **Size the TPM limit against the Partner agent's biggest search.** It packs one studio
   > profile per partner into a single AI call; if that call is bigger than your per-minute
   > allowance, *every* search fails with a "429." Navio is tuned to send about 40 candidates and
   > show 5, which keeps calls small — keep the Azure limit consistent with that.

4. **Optional dollar hard-stop (Vercel AI Gateway).** On Pro you can route the AI through Vercel's
   **AI Gateway** with your own Azure key and give it a **spending budget** that simply stops
   serving once hit. Set `AI_GATEWAY_MODEL` (and `AI_GATEWAY_API_KEY`) and redeploy; the code
   switches to the gateway automatically.

✅ **Checkpoint:** Azure shows your TPM limit and a monthly budget with an alert email; a flood is
throttled by the firewall + Azure instead of running up cost.

---

## §7 — Monitoring and production checks

Watch these after launch, so you find problems before your users do:

| What to watch | Where to look |
|---|---|
| **Suspicious / blocked traffic**, which rules are firing | Vercel → **Firewall → Traffic** |
| **Failed requests, errors, slow responses** | Vercel → project → **Logs** and **Observability** |
| **AI spend / high token usage** | **Azure Cost Management** (+ AI Gateway logs if used) |
| **Agent errors, detailed traces, quality** | **LangSmith** (EU region), if you set the `LANGSMITH_*` keys — see [`../DEV-CONSOLE-MONITORING.md`](../DEV-CONSOLE-MONITORING.md) |

> **Logs** = the running diary of what the app did. **OpenTelemetry** = the industry-standard way
> Navio records detailed traces of each request; those traces flow to **LangSmith**, a tool for
> inspecting AI conversations, cost, and errors. Both are optional but recommended.

**Set at least these alerts:** the Azure monthly **budget email** (§6), and — if you have
Observability — a heads-up on a spike in **errors** or **blocked traffic**. Check the Firewall
Traffic page daily for the first week.

✅ **Checkpoint:** you can open each of the four places above and see live data.

---

## §8 — Custom domains and final launch

### §8a — Custom domains (§11 of the flow)

1. **Project 1 (public):** Settings → **Domains** → add **`chat.sportnavi.de`** → add the **CNAME**
   record Vercel shows you at sportnavi.de's DNS host → wait for the green "valid" state.
2. **Project 2 (internal):** add a **non-obvious** address, e.g. **`partner.sportnavi.de`**. Then go
   back to **project 1 → Environment Variables**, update **`PARTNER_AGENT_HOST`** to that address,
   and **Redeploy**.
3. **Now flip Rule A to Deny and Publish** (its earlier warning no longer applies — your real
   origin is live). Also flip Rules B–E to **429**.

### §8b — Lock down project 2's console (§10 of the flow)

Project 2's code already **redirects its console to a harmless health page in production**, so a
visitor to its address sees nothing useful and the shared secret guards the API. For belt-and-braces
on Pro, you may also enable **Deployment Protection** on project 2 (Settings → **Deployment
Protection**) so even that health page requires Vercel login. The API path your proxy uses keeps
working because it authenticates with the shared secret, not a browser login.

### §8c — Embed on the website (§12 of the flow)

Give your web team **one line** to drop into any sportnavi.de page (ideally the global
footer/layout so it appears everywhere):

```html
<script src="https://chat.sportnavi.de/launcher.js" async></script>
```

That's the floating chat button. The script figures out its own address from that `src`, so the
same line works on the live site, previews, and locally with no edits. Who may **embed** it is
controlled by `WIDGET_FRAME_ANCESTORS` + Rule A (§3d).

### §8d — Final production checklist

**Before launch**

- [ ] Secrets configured (Azure, database, embedding, **shared secret matches in both projects**)
- [ ] Old `.mcp.json` LangSmith/Stitch keys **rotated**
- [ ] Firewall rules A–E created (start in **Log**, then **Deny/429**)
- [ ] Bot protection (**BotID**) enabled, both env switches `= true`
- [ ] Widget only works on the official domain (`WIDGET_FRAME_ANCESTORS` + Rule A)
- [ ] Both agents protected (FAQ: origin + BotID + token limits; Partner: shared secret + console
      redirect)
- [ ] Cost limits configured (Azure TPM + monthly budget; optional AI Gateway cap)
- [ ] Monitoring enabled (Firewall Traffic, Logs, Azure budget alert, LangSmith if used)

**After launch**

- [ ] Test all three cards from **sportnavi.de** → all work
- [ ] Test from **another website** (copy the embed code onto a test page) → the widget **refuses
      to load** and a direct API call is **denied**
- [ ] Test a **burst** of rapid requests → you get **429** (rate limited), not a runaway bill
- [ ] Confirm **no secrets are exposed** — view the page source; only `NEXT_PUBLIC_*` values (BotID
      switches, public link URLs) should appear, never a real key
- [ ] Confirm project 2's address does **not** show a usable console

---

## Rollback

If a deploy goes wrong: project → **Deployments** → pick a known-good earlier build → **⋯ → Promote
to Production**. Environment-variable changes require a **Redeploy** to take effect.

---

## Appendix — if you're on the Hobby (free) plan instead of Pro

Hobby allows **3 custom firewall rules total (1 of them a rate-limit rule)** and only **Basic**
BotID. Prioritise, per project:

- **Project 1:** **Rule A (origin lock)** + **Rule B (limit starting a chat)** + rely on the §6
  spend cap for everything else.
- Everything else (Rules C–E, Deep-Analysis BotID) unlocks on **Pro**.

DDoS/flood protection and the origin lock still work on Hobby, so **spend cap + origin lock + one
rate-limit rule** is a reasonable public-launch baseline until you upgrade.

| Control | Hobby | Pro |
|---|---|---|
| AI Gateway hard spend cap | ✅ | ✅ |
| Origin allowlist (firewall) | ✅ | ✅ |
| Rate-limit rules | ⚠️ 1 rule (3 custom total) | up to 40, JA4 keys |
| BotID | ⚠️ Basic only | **Deep Analysis** |
| DDoS protection | ✅ automatic | ✅ automatic |

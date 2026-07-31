# Kontaktformular — Complete Integration & Setup Guide

Everything needed to wire the Navio Plus contact form into any app, in one document: architecture, the request/response contract, the full environment-variable reference, the Salesforce OAuth + flow calls, field mapping, the complete cascading picklist data, and deployment notes.

> ⚠️ **Secrets in this file are placeholders.** Never commit real Salesforce credentials or SMTP passwords. If a real `SALESFORCE_CLIENT_SECRET` is ever pasted into chat, a commit, or a screenshot, rotate it in Salesforce and update your secret store — treat the old value as burned.

---

## 1. What it does & the golden rule

The Kontaktformular collects a support request and creates a **Case in Salesforce** by triggering the `CaseHandler` flow.

**Golden rule: the browser NEVER talks to Salesforce.** The Salesforce `client_id` / `client_secret` are secrets — they live only on the server. The browser posts to *your own backend*, which authenticates to Salesforce and triggers the flow server-side.

```
[ Browser ]                    [ Your backend ]                 [ Salesforce ]
  Contact form ─POST /api/contact─▶  contact()
   (form UI)                          │ 1. validate the payload
                                      │ 2. map fields → flow inputs
                                      │ 3. get OAuth token (cached)
                                      │ 4. POST the CaseHandler flow ───────▶  Case created
                                      │
                                      │ (on failure) ─▶ send fallback email ─▶ service@…
                                      ▼
                              returns {status:"ok"}
```

Three moving parts:
1. **Frontend** — a form that posts a flat JSON payload to `POST /api/contact`.
2. **Backend endpoint** — validates, maps to Salesforce input names, calls Salesforce, falls back to email on failure.
3. **Salesforce connector** — OAuth `client_credentials` + trigger the named flow.

---

## 2. The request contract

```
POST /api/contact
Content-Type: application/json
```

**No authentication** (no session, no token, no consent header) — the only gate is a per-IP rate limit. CORS allows methods `GET`/`POST` and request headers `Content-Type, X-Navio-Session, X-Admin-Token, Authorization`. Any other custom header fails the CORS preflight.

### Payload — 10 string fields

| Field | Required | Max length | Salesforce flow input | Notes |
|---|---|---|---|---|
| `membership` | ✅ | 40 | `MembershipType` | cascading picklist **value** (see §7) |
| `grund` | ✅ | 120 | `CaseGrounds` | cascading picklist value |
| `thema` | ✅ | 120 | `Topic` | cascading picklist value |
| `kurzbeschreibung` | ✅ | 300 | `ShortDescription` | cascading picklist value |
| `betreff` | ✅ | 200 | `Subject` | free text |
| `name` | ✅ | 120 | `Name` | free text |
| `email` | ✅ | 3–200 | `Email` | **length only** — no format check server-side |
| `nachricht` | ✅ | 2000 | `Description` | free text (`MAX_MESSAGE_CHARS`) |
| `telefon` | ❌ | 40 | `Phone` | `null`/omitted → sent as `""` |
| `kundennummer` | ❌ | 60 | `CustomerNumber` | `null`/omitted → sent as `""` |

Required fields use `min_length=1` — an empty string is rejected, not treated as missing. Values pass through to Salesforce **unchanged** — the backend does no translation or picklist validation.

### Example request

```json
{
  "membership": "Private",
  "grund": "Membership administration (Private)",
  "thema": "Problem logging in",
  "kurzbeschreibung": "Ich kann mich in die App nicht einloggen",
  "betreff": "Login funktioniert nicht",
  "name": "Max Mustermann",
  "email": "max@example.com",
  "nachricht": "Seit gestern komme ich nicht mehr rein.",
  "telefon": null,
  "kundennummer": null
}
```

```bash
curl -X POST https://YOUR-BACKEND/api/contact \
  -H "Content-Type: application/json" \
  -d '{"membership":"Private","grund":"Membership administration (Private)","thema":"Problem logging in","kurzbeschreibung":"Ich kann mich in die App nicht einloggen","betreff":"Test","name":"Max Mustermann","email":"max@example.com","nachricht":"Hallo"}'
```

### Responses

| Status | Body | Meaning |
|---|---|---|
| 200 | `{"status":"ok"}` | Case created in Salesforce |
| 200 | `{"status":"ok","simulated":true}` | **No credentials configured** — nothing sent anywhere; payload logged at WARNING |
| 200 | `{"status":"ok","fallback":"email"}` | Salesforce failed; request emailed to the fallback address |
| 422 | FastAPI validation error | A field is missing, empty, or over its length cap |
| 429 | `{"detail":"Zu viele Anfragen …"}` | Rate limit exceeded |
| 502 | `{"detail":"Senden fehlgeschlagen …"}` | Salesforce **and** the fallback email both failed (payload still logged at ERROR) |

> ⚠️ All three 200 variants are `res.ok`. A client that only checks `res.ok` **cannot tell a real Case from a simulated one or an email fallback** — read the JSON body if you need to distinguish. Confirm live wiring with `GET /health` → `"salesforce": true`.

---

## 3. Frontend — how the form posts

The form submits a flat payload; the client throws only on `!res.ok`:

```ts
export type ContactPayload = {
  membership: string; grund: string; thema: string; kurzbeschreibung: string
  betreff: string; name: string; email: string
  telefon?: string; kundennummer?: string; nachricht: string
}

export async function submitContact(payload: ContactPayload, signal?: AbortSignal): Promise<void> {
  const res = await fetch(`${API_BASE}/api/contact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  })
  if (!res.ok) {
    const detail = await res.json()
      .then(d => (typeof d?.detail === 'string' ? d.detail : undefined))
      .catch(() => undefined)
    throw new Error(detail ?? `Senden fehlgeschlagen (${res.status}). Bitte später erneut versuchen.`)
  }
}
```

- `API_BASE` is empty in dev (a dev proxy forwards `/api` to the backend, so there is no CORS); in production set it to the backend origin, or set it at runtime with `setApiBase(url)` (the embeddable widget does this).
- **Client-side only, NOT enforced by the backend** (so any direct API caller bypasses them): the email-format regex, the required-field checks, and the two consent checkboxes (Datenschutz, Widerruf). Those checkboxes are **not** part of the payload and never reach the server.

---

## 4. Backend endpoint — validation & field mapping

The endpoint validates the payload, maps the German form fields to the Salesforce flow's input variable names, then calls the connector:

```python
class ContactRequest(BaseModel):
    membership: str = Field(min_length=1, max_length=40)
    grund: str = Field(min_length=1, max_length=120)
    thema: str = Field(min_length=1, max_length=120)
    kurzbeschreibung: str = Field(min_length=1, max_length=300)
    betreff: str = Field(min_length=1, max_length=200)
    name: str = Field(min_length=1, max_length=120)
    email: str = Field(min_length=3, max_length=200)
    telefon: str | None = Field(default=None, max_length=40)
    kundennummer: str | None = Field(default=None, max_length=60)
    nachricht: str = Field(min_length=1, max_length=MAX_MESSAGE_CHARS)

@app.post("/api/contact")
@limiter.limit(f"{RATE_LIMIT_PER_MIN}/minute")
@limiter.limit(f"{RATE_LIMIT_PER_DAY}/day")
def contact(request: Request, body: ContactRequest) -> dict:
    inputs = {
        "MembershipType":   body.membership,
        "CaseGrounds":      body.grund,
        "Topic":            body.thema,
        "ShortDescription": body.kurzbeschreibung,
        "Subject":          body.betreff,
        "Name":             body.name,
        "Email":            body.email,
        "Phone":            body.telefon or "",
        "CustomerNumber":   body.kundennummer or "",
        "Description":      body.nachricht,
    }

    # No credentials configured → simulate success so the form stays demoable.
    if not salesforce_enabled():
        log.warning("CONTACT (simulated): %s", inputs)
        return {"status": "ok", "simulated": True}

    ok, detail = submit_case(inputs)
    if ok:
        return {"status": "ok"}

    # Salesforce failed → email the request so nothing is lost.
    emailed = send_fallback_email(
        subject=f"[Navio Kontakt] {body.betreff} — {body.name}",
        body=contact_email_body(inputs, detail),
    )
    if emailed:
        return {"status": "ok", "fallback": "email"}
    raise HTTPException(502, "Senden fehlgeschlagen. Bitte später erneut versuchen.")
```

---

## 5. Salesforce connector — the two Salesforce calls

### Step 1 — OAuth token (`client_credentials`)

Cached with a soft TTL, refreshed on expiry or a `401`. A lock prevents concurrent requests from stampeding the token endpoint.

```
POST {SALESFORCE_TOKEN_URL}
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
client_id={SALESFORCE_CLIENT_ID}
client_secret={SALESFORCE_CLIENT_SECRET}
```

The response returns `access_token` and `instance_url`. The `instance_url` from the token response is **preferred** over `SALESFORCE_INSTANCE_URL` when present.

### Step 2 — trigger the flow

```
POST {instance_url}/services/data/{SALESFORCE_API_VERSION}/actions/custom/flow/{SALESFORCE_FLOW_API_NAME}
Authorization: Bearer {access_token}
Content-Type: application/json

{
  "inputs": [
    {
      "MembershipType": "Private",
      "CaseGrounds": "Membership administration (Private)",
      "Topic": "Problem logging in",
      "ShortDescription": "Ich kann mich in die App nicht einloggen",
      "Subject": "Login funktioniert nicht",
      "Name": "Max Mustermann",
      "Email": "max@example.com",
      "Phone": "",
      "CustomerNumber": "",
      "Description": "Seit gestern komme ich nicht mehr rein."
    }
  ]
}
```

Success **only** when the flow response's first list item has `isSuccess: true`. The connector retries **once** after a forced token refresh on a `401`.

### Reference implementation (Python / httpx)

```python
import os, time, threading, smtplib, logging
from email.message import EmailMessage
import httpx

log = logging.getLogger("navio.salesforce")

CLIENT_ID     = os.getenv("SALESFORCE_CLIENT_ID", "").strip()
CLIENT_SECRET = os.getenv("SALESFORCE_CLIENT_SECRET", "").strip()
TOKEN_URL     = os.getenv("SALESFORCE_TOKEN_URL", "https://YOUR-ORG.my.salesforce.com/services/oauth2/token").strip()
INSTANCE_URL  = os.getenv("SALESFORCE_INSTANCE_URL", "https://YOUR-ORG.my.salesforce.com").strip().rstrip("/")
API_VERSION   = os.getenv("SALESFORCE_API_VERSION", "v65.0").strip()
FLOW_API_NAME = os.getenv("SALESFORCE_FLOW_API_NAME", "CaseHandler").strip()
TOKEN_TTL     = float(os.getenv("SALESFORCE_TOKEN_TTL_SEC", "3600"))
TIMEOUT       = float(os.getenv("SALESFORCE_TIMEOUT_SEC", "15"))

_lock = threading.Lock()
_token = None; _token_instance = None; _fetched_at = 0.0

def salesforce_enabled() -> bool:
    return bool(CLIENT_ID and CLIENT_SECRET)

def _fetch_token():
    r = httpx.post(TOKEN_URL,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        data={"grant_type": "client_credentials", "client_id": CLIENT_ID, "client_secret": CLIENT_SECRET},
        timeout=TIMEOUT)
    r.raise_for_status()
    d = r.json()
    if not d.get("access_token"):
        raise RuntimeError(f"token response missing access_token: {d}")
    return d["access_token"], (d.get("instance_url") or INSTANCE_URL).rstrip("/")

def _get_token(force=False):
    global _token, _token_instance, _fetched_at
    with _lock:
        fresh = _token and (time.time() - _fetched_at) < TOKEN_TTL
        if force or not fresh:
            _token, _token_instance = _fetch_token(); _fetched_at = time.time()
        return _token, _token_instance

def submit_case(inputs: dict):
    """Returns (ok, detail). ok is True only when the flow returns isSuccess=true."""
    if not salesforce_enabled():
        return False, "salesforce not configured"
    body = {"inputs": [inputs]}
    for attempt in (1, 2):                       # 2nd attempt = after a forced refresh on 401
        token, instance = _get_token(force=(attempt == 2))
        url = f"{instance}/services/data/{API_VERSION}/actions/custom/flow/{FLOW_API_NAME}"
        try:
            r = httpx.post(url, headers={"Authorization": f"Bearer {token}",
                           "Content-Type": "application/json"}, json=body, timeout=TIMEOUT)
        except httpx.HTTPError as e:
            return False, f"transport error: {e}"
        if r.status_code == 401 and attempt == 1:
            continue
        if r.status_code >= 400:
            return False, f"HTTP {r.status_code}: {r.text[:500]}"
        try:
            results = r.json(); first = results[0] if isinstance(results, list) and results else {}
        except Exception:
            return False, f"unparseable flow response: {r.text[:500]}"
        if first.get("isSuccess") is True:
            return True, str(first.get("outputValues", ""))
        return False, f"flow isSuccess=false: {first.get('errors') or first}"
    return False, "unreachable"
```

### Behaviour that matters

- **Simulate mode:** if *either* credential is empty, `salesforce_enabled()` is `False` — the endpoint returns `{"simulated": true}` and contacts nothing. This is the single most common cause of "the form says success but no Case appeared." Check `GET /health` before concluding the integration works.
- **Fallback email:** on flow failure (or a transport error / timeout) the request is emailed to `CONTACT_FALLBACK_EMAIL`. With no SMTP configured, the full payload is logged at ERROR instead — still recoverable from logs.
- **Possible duplicate on timeout:** a timeout *after* Salesforce already created the Case is treated as a failure → the fallback email fires, so the team may receive both a Case and an email. (The internal `401` retry is safe — an auth-rejected request was never processed.)
- **Rate-limit budget is shared** with the chat endpoints, per client IP. Without a shared Redis store, counters are per-process, so multi-instance deployments allow a higher effective limit than configured.

### Fallback email (SMTP) reference

```python
FALLBACK_TO   = os.getenv("CONTACT_FALLBACK_EMAIL", "service@YOUR-DOMAIN.de").strip()
MAIL_FROM     = os.getenv("CONTACT_FROM_EMAIL", "").strip() or FALLBACK_TO
SMTP_HOST     = os.getenv("SMTP_HOST", "").strip()
SMTP_PORT     = int(os.getenv("SMTP_PORT", "587"))
SMTP_USER     = os.getenv("SMTP_USER", "").strip()
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD", "").strip()
SMTP_STARTTLS = os.getenv("SMTP_STARTTLS", "true").strip().lower() not in ("0", "false", "no")

def send_fallback_email(subject: str, body: str) -> bool:
    if not SMTP_HOST:
        log.error("CONTACT FALLBACK (no SMTP) — %s\n%s", subject, body)
        return False
    try:
        msg = EmailMessage()
        msg["Subject"] = subject; msg["From"] = MAIL_FROM; msg["To"] = FALLBACK_TO
        msg.set_content(body)
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=TIMEOUT) as s:
            if SMTP_STARTTLS: s.starttls()
            if SMTP_USER: s.login(SMTP_USER, SMTP_PASSWORD)
            s.send_message(msg)
        return True
    except Exception as e:
        log.error("CONTACT FALLBACK email FAILED (%s) — %s\n%s", e, subject, body)
        return False
```

---

## 6. Environment variables — complete reference

All server-side. Put them in your backend's `.env` (git-ignored) or the host's env-var settings. **Fill secrets from your secret store — never hardcode them in committed files.**

```bash
# --- Salesforce (contact form → CaseHandler flow) ---------------------------
# SECRETS — from your Salesforce Connected App. Leave BOTH empty for simulate mode.
SALESFORCE_CLIENT_ID=<from-secret-store>
SALESFORCE_CLIENT_SECRET=<from-secret-store>

# Non-secret config (change per environment / org):
SALESFORCE_TOKEN_URL=https://YOUR-ORG.my.salesforce.com/services/oauth2/token
SALESFORCE_INSTANCE_URL=https://YOUR-ORG.my.salesforce.com
SALESFORCE_API_VERSION=v65.0
SALESFORCE_FLOW_API_NAME=CaseHandler
SALESFORCE_TOKEN_TTL_SEC=3600     # soft token cache TTL (client_credentials has no expires_in)
SALESFORCE_TIMEOUT_SEC=15         # HTTP timeout for both the token and flow calls

# --- Fallback email (used only when Salesforce fails) -----------------------
CONTACT_FALLBACK_EMAIL=service@YOUR-DOMAIN.de   # recipient for failed submissions
CONTACT_FROM_EMAIL=                             # From: address (defaults to fallback)
SMTP_HOST=                                      # empty ⇒ no email; logs at ERROR instead
SMTP_PORT=587
SMTP_USER=                                      # empty ⇒ login skipped (unauthenticated send)
SMTP_PASSWORD=
SMTP_STARTTLS=true

# --- Related (affect this endpoint) -----------------------------------------
MAX_MESSAGE_CHARS=2000                          # cap on `nachricht`
RATE_LIMIT_PER_MIN=15                           # per-IP/minute (SHARED with chat endpoints)
RATE_LIMIT_PER_DAY=300                          # per-IP/day (SHARED with chat endpoints)
ALLOWED_ORIGINS=https://YOUR-DOMAIN.de          # CORS allowlist (comma-separated)
REDIS_URL=                                      # shared rate-limit store; empty ⇒ per-process counters
```

| Variable | Secret? | Default | Purpose |
|---|---|---|---|
| `SALESFORCE_CLIENT_ID` | 🔒 yes | — | OAuth client id of the Connected App. **Empty ⇒ simulate mode.** |
| `SALESFORCE_CLIENT_SECRET` | 🔒 yes | — | OAuth client secret. **Empty ⇒ simulate mode.** |
| `SALESFORCE_TOKEN_URL` | no | `https://sportnavi.my.salesforce.com/services/oauth2/token` | OAuth token endpoint |
| `SALESFORCE_INSTANCE_URL` | no | `https://sportnavi.my.salesforce.com` | Fallback instance URL (token's `instance_url` wins) |
| `SALESFORCE_API_VERSION` | no | `v65.0` | REST API version in the flow URL |
| `SALESFORCE_FLOW_API_NAME` | no | `CaseHandler` | Autolaunched flow API name to trigger |
| `SALESFORCE_TOKEN_TTL_SEC` | no | `3600` | Soft token cache TTL |
| `SALESFORCE_TIMEOUT_SEC` | no | `15` | HTTP timeout (token + flow) |
| `CONTACT_FALLBACK_EMAIL` | no | `service@sportnavi.de` | Recipient for failed submissions |
| `CONTACT_FROM_EMAIL` | no | = fallback email | `From:` header |
| `SMTP_HOST` | no | — | SMTP relay host. **Empty ⇒ no email; logs payload at ERROR.** |
| `SMTP_PORT` | no | `587` | SMTP port |
| `SMTP_USER` | 🔒 if set | — | SMTP username (empty ⇒ unauthenticated send) |
| `SMTP_PASSWORD` | 🔒 if set | — | SMTP password |
| `SMTP_STARTTLS` | no | `true` | STARTTLS on the connection (`0`/`false`/`no` disables) |
| `MAX_MESSAGE_CHARS` | no | `2000` | Cap on `nachricht` |
| `RATE_LIMIT_PER_MIN` | no | `15` | Per-IP/minute (shared with chat) |
| `RATE_LIMIT_PER_DAY` | no | `300` | Per-IP/day (shared with chat) |
| `ALLOWED_ORIGINS` | no | `https://sportnavi.de,https://www.sportnavi.de` | CORS allowlist for the browser |
| `REDIS_URL` | no | — | Shared rate-limit store; without it, counters are per-process |
| `VITE_NAVIO_API` *(frontend)* | no | — | Backend origin in production (empty in dev = proxy) |

---

## 7. Cascading picklists — rule + complete data

`membership → grund → thema → kurzbeschreibung` are **dependent** Salesforce picklists. A child value that is not valid for its selected parent makes the `CaseHandler` flow **reject** the Case → the caller gets a `502`, not a validation error. The backend does **not** check this, so the UI must.

Each option has a **`value`** (the exact Salesforce API value → **this is what you send**) and a **`label`** (German display text for the UI → sending this **fails**). Example: send `"Private"`, never `"Privatmitglied"`.

**Rule any caller must implement:** whenever a parent selection changes, reset all of its children — so an invalid chain can never be assembled.

### Level 1 — Membership (`MembershipType`)

| value | label (DE) |
|---|---|
| `Corporate Fitness` | Firmenmitglied |
| `Private` | Privatmitglied |
| `No Membership` | Kein Mitglied |

### Level 2 — CaseGrounds (`grund`), by membership

| Parent membership | Allowed `grund` values |
|---|---|
| `Corporate Fitness` | `Membership administration (Corporate)`, `General question`, `Partner-related question` |
| `Private` | `Membership administration (Private)`, `General question`, `Partner-related question` |
| `No Membership` | `General question`, `Partner-related question` |

Labels: *Membership administration (Corporate)* = "Meine Mitgliedschaft verwalten (Firma)", *Membership administration (Private)* = "Meine Mitgliedschaft verwalten (Privat)", *General question* = "Anmeldung und allgemeine Fragen", *Partner-related question* = "Partnerbezogene Fragen".

### Level 3 — Topic (`thema`), by CaseGrounds

| Parent `grund` | Allowed `thema` values |
|---|---|
| `Membership administration (Corporate)` | `Problem logging in`, `Adjust my plan (Corporate)`, `Corporate rates`, `Question about cancellation`, `Payment/Invoices`, `Update personal information`, `My membership start date`, `Other` |
| `Membership administration (Private)` | `Problem logging in`, `Adjust my plan (Private)`, `Discounts/Coupons`, `Question about cancellation`, `Payment/Invoices`, `Pause my membership`, `Update personal information`, `My membership start date`, `Other` |
| `General question` | `I need to contact a department`, `Data protection`, `Technical problems`, `Feedback about the app or website`, `I want to reactivate my membership`, `Questions before logging in/becoming a member`, `Other` |
| `Partner-related question` | `Cashback`, `Reservation problems`, `Live courses/Online courses`, `Information about a specific partner`, `Find partners in our app`, `Check-in management`, `Other` |

### Level 4 — ShortDescription (`kurzbeschreibung`), by Topic

For this level `value` = `label` (both German). Allowed values per topic:

| Parent `thema` | Allowed `kurzbeschreibung` values |
|---|---|
| `Problem logging in` | Ich kann mich in die App nicht einloggen · Ich habe keinen Link zum Zurücksetzen meines Passwortes bekommen · Ich kann meine Mitgliedschaft nicht verbinden · Sonstiges |
| `Adjust my plan (Private)` | Ich möchte zu einer Firmenmitgliedschaft wechseln · Ich möchte meine Privatmitgliedschaft downgraden · Ich möchte meine Privatmitgliedschaft upgraden · Sonstiges |
| `Adjust my plan (Corporate)` | Ich möchte zu einer Privatmitgliedschaft wechseln · Ich wechsle meinen aktuellen Arbeitgeber · Sonstiges |
| `Discounts/Coupons` | Corporate Benefits / Mitarbeitervorteile · Ich habe ein Problem, einen aktuellen Rabatt betreffend · Information über Family&Friends · Wie sehen die Konditionen meiner Mitgliedschaft aus · Geschenkgutscheine · Sonstiges |
| `Corporate rates` | Corporate Benefits / Mitarbeitervorteile · Information über Family&Friends · Wie sehen die Konditionen meiner Mitgliedschaft aus · Sonstiges |
| `Question about cancellation` | Ich wechsle meinen aktuellen Arbeitgeber · Ich habe gekündigt, aber mir wurde ein Betrag abgebucht · Wie kündige ich eine Mitgliedschaft? · Wie widerrufe ich meine Mitgliedschaft? · Sonstiges |
| `Payment/Invoices` | Meine Mitgliedschaft wurde gesperrt · Ich habe eine Zahlung versäumt · Mir wurde der falsche Betrag abgebucht/ in Rechnung gestellt · Allgemeine Fragen zu Zahlungen/Rechnungen · Sonstiges |
| `Pause my membership` | Ich möchte meine Mitgliedschaft pausieren · Ich möchte meine Pause aufheben · Ich möchte eine Änderung meiner Pause beantragen · Sonstiges |
| `Update personal information` | Adresse/ Telefonnummer ändern · Name oder E-Mail ändern · Bankverbindung ändern · Sonstiges |
| `My membership start date` | Anmeldebestätigung · Sonstiges |
| `I need to contact a department` | Personalabteilung · Marketing · Customer Service · Firmen Management · Partner (Success) Management · Sonstiges |
| `Data protection` | Allgemeine Datenbestandsabfragen · Allgemeine Anfrage / Sonstiges · Antrag auf Berichtigung der Daten · Antrag auf Lösung der Daten / Einschränkung der Verarbeitung · Sonstiges |
| `Technical problems` | Sonstiges |
| `Feedback about the app or website` | Sonstiges |
| `I want to reactivate my membership` | Sonstiges |
| `Questions before logging in/becoming a member` | Unterschied Privat/Firmenmitgliedschaft · Wie melde ich mich an? · Wie funktioniert Sportnavi? · Wie kann ich mich über meine Arbeitgeber /Verein etc. anmelden · Sonstiges |
| `Cashback` | Wie funktioniert es? · Sonstiges |
| `Reservation problems` | Sonstiges |
| `Live courses/Online courses` | Wie funktioniert es? · Ich habe technische Probleme · Ich habe keine E-Mail mit dem Link erhalten · Kurse vor Ort · Sonstiges |
| `Information about a specific partner` | Informationen bezüglich des Partnerprofils · Erfahrung bei einem Partner · Sonstiges |
| `Find partners in our app` | Sonstiges |
| `Check-in management` | Ich kann mich nicht einchecken · Ich möchte einen Check-In hinzufügen · Ich möchte die App auf einem anderen Endgerät nutzen · Sonstiges |
| `Other` | Sonstiges |

> This is a generated snapshot of the live Salesforce picklists + `validFor` dependency metadata. There is **no automatic refresh** — regenerate it after any Salesforce picklist change, or previously valid combinations will start failing at the flow with no local signal.

---

## 8. Wiring it into any app

Pick the layer you're integrating at.

**A. You already have this backend — just build a new frontend form.**
Post the §2 payload to `POST /api/contact`. Reproduce the §7 cascade rule (reset children on parent change). Send picklist **values**, not labels. Done.

**B. You have a different backend — port the endpoint.**
Recreate three pieces: (1) a validated request model = the §4 `ContactRequest`; (2) the field→input mapping dict; (3) the two Salesforce calls from §5 (OAuth `client_credentials`, then POST the flow) with token caching + one `401` retry. Add the §6 env vars. Keep the simulate-mode and fallback-email safety nets.

**C. Different Salesforce org / different flow.**
Change `SALESFORCE_TOKEN_URL`, `SALESFORCE_INSTANCE_URL`, and `SALESFORCE_FLOW_API_NAME`; set the org's own `CLIENT_ID`/`SECRET`. Make sure your flow declares input variables **matching the mapping keys** — `MembershipType`, `CaseGrounds`, `Topic`, `ShortDescription`, `Subject`, `Name`, `Email`, `Phone`, `CustomerNumber`, `Description` — or rename both sides together. Regenerate the §7 picklist data from *your* org's metadata.

**D. No Salesforce yet (demo/testing).**
Leave both credentials empty → simulate mode. The full UI works and returns success without any Salesforce account.

**Adding a field — change all 5 places, in order:**
1. Frontend form — state, input, validation.
2. Frontend `ContactPayload` type.
3. Backend `ContactRequest` (with a length cap).
4. Backend `inputs` mapping dict → the flow's input name.
5. Salesforce — the flow must declare the matching input variable, or it rejects the request. (This step is outside the code and the usual reason a correct-looking change fails in prod.)

---

## 9. Deployment — injecting env vars per host

- **Local / uvicorn:** put the vars in `backend/.env` (git-ignored). Never commit it.
- **Docker / any host:** run with `--env-file backend/.env`.
- **Google Cloud Run:** secrets go into **Secret Manager**; non-secret config in a `cloudrun.env.yaml`.
- **Vercel:** paste the same keys into Project → Settings → Environment Variables (no `.env` file uploaded).

Whichever host: `SALESFORCE_CLIENT_ID`, `SALESFORCE_CLIENT_SECRET`, and any `SMTP_*` credentials must be provided as **secrets**, not plain config, and must never be exposed to the browser bundle.

---

## 10. Security

- 🔒 **Server-side only.** The Salesforce client id/secret and SMTP credentials must never reach the frontend bundle or a public repo. The browser only ever sees `POST /api/contact`.
- 🔑 **Rotate leaked secrets.** If a client secret is ever pasted into chat, email, a commit, or a screenshot, regenerate it in Salesforce (new Connected App secret) and update your secret store. Treat the old value as compromised.
- 🧾 **Placeholders on purpose.** This document uses `<from-secret-store>` and `YOUR-ORG` deliberately. Fill real values only in your local `.env` / secret manager.
- 🛡️ **The endpoint is unauthenticated** — only IP rate-limited, and that budget is shared with chat endpoints. If you expose it publicly, add a CAPTCHA/Turnstile or a dedicated abuse limit.
- ✅ **Consent is UI-only.** The Datenschutz/Widerruf checkboxes never reach the backend. If you need server-recorded consent, add explicit fields to the payload and the request model.

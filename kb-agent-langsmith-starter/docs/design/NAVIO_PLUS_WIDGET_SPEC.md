# Navio Plus — Widget Design Specification

> **Screen-by-screen design reference for the Navio Plus FAQ Agent widget.**
>
> This document describes **every screen the widget opens**, its layout, all UI elements, colors, typography, spacing, navigation flow, and animations — everything needed to faithfully recreate the widget in another project. It documents *design and UI only*; business logic, API wiring, and agent behavior are out of scope.
>
> For the underlying design system (raw tokens, component styling rules, do's & don'ts) see the companion [WIDGET-DESIGN-GUIDELINES.md](WIDGET-DESIGN-GUIDELINES.md). This spec is the *walkthrough*; that file is the *system*.

---

## 0. What Navio Plus is (design-wise)

Navio Plus is the **menu variant** of the widget. Where the plain Navio bot drops straight into chat after consent, Navio Plus inserts a **menu step** offering two paths — the **FAQ agent** (live chat) and a **Kontaktformular** (contact form) — inside one widget.

- **Bot identity:** name `Navio Plus`, icon `Sparkles`, role *"menü · faq + kontakt"*.
- **Source components:** `ChatWidget` (launcher shell) → `NavioMenuChat` (menu shell) → `NavioMenu`, `NavioChat` (embedded FAQ), `KontaktForm`.
- **Signature look:** white rounded panel, **Sportnavi-green header**, ink launcher with a green glow, soft shadows, pill buttons, bilingual (DE/EN) copy.

---

## 1. Screen inventory & navigation flow

The widget opens these screens, in this order:

```
        ┌────────────────────┐
        │  0. Launcher (FAB)  │  ink bubble, bottom-right
        └─────────┬──────────┘
             tap  │
        ┌─────────▼──────────┐
        │  1. Greeting Card  │  "Hi, ich bin Navio 👋🏻" + CTA
        └─────────┬──────────┘
     "Mit Navio   │
      chatten"    │
        ┌─────────▼──────────┐
        │  2. Consent Gate   │  Datenschutzhinweis · Zustimmen / Ablehnen
        └─────────┬──────────┘
       Zustimmen  │
        ┌─────────▼──────────┐
        │  3. Menu           │  [FAQ-Agent]  [Kontaktformular]
        └────┬──────────┬────┘
       FAQ   │          │  Kontakt
   ┌─────────▼───┐  ┌───▼──────────────┐
   │ 4a. FAQ Chat│  │ 4b. Kontaktform  │
   └─────────────┘  └───┬──────────────┘
                    submit│
                    ┌─────▼──────────┐
                    │ 4c. Success    │
                    └────────────────┘

   Any screen (menu) → [ⓘ] → 5. Info panel ("Über Navio Plus")
```

**Header navigation rules** (which control appears when):

| Screen | Left slot | Right controls |
|---|---|---|
| Menu | bot avatar | 🌙/☀️ theme · ⓘ info · ✕ close |
| FAQ chat | ← back (to menu) | ↻ reset · ✕ close |
| Kontaktform | ← back (to menu) | ✕ close |
| Info panel | ← back | ✕ close |

Back always returns to the **menu**; there is no deep back-stack.

---

## 2. Global shell (applies to every screen except launcher/card)

Every full screen shares one container and chrome:

- **Panel container:** `flex flex-col overflow-hidden rounded-3xl border border-border bg-surface text-fg`
  - Size (when floating): `h-[min(560px,72vh)] w-[min(380px,calc(100vw-3rem))]`, `origin-bottom-right`, `soft-shadow-lg`.
- **Vertical stack (fixed order):**
  1. **Header** — green bar, fixed height
  2. **Body** — `flex-1 overflow-y-auto` (the *only* scrolling region)
  3. **Footer** — privacy link, fixed
- **Footer (constant):** `border-t border-border bg-surface px-4 py-2 text-center` holding one link:
  `Datenschutz · Privacy Policy` — `text-[11px] text-fg-subtle underline hover:text-fg`, opens in new tab.

### Header anatomy (constant structure, `bg-brand-green px-4 py-3 text-white`)

`flex items-center gap-3`:
- **Left slot** (`h-9 w-9`): either the avatar `rounded-full bg-white text-brand-green` holding `<Sparkles>` (`h-5 w-5`), **or** a `ArrowLeft` back button `rounded-full bg-white/15 hover:bg-white/30`.
- **Title block** (`min-w-0 flex-1`): title line `font-display text-sm font-semibold leading-tight truncate`; subtitle row `text-xs text-white/85` — when subtitle is *"Online"* it's prefixed by a `h-1.5 w-1.5 rounded-full bg-white` dot.
- **Right controls:** round `h-8 w-8 rounded-full bg-white/15 hover:bg-white/30` icon buttons (`transition-colors`), each `h-4 w-4` icon + `aria-label`.

**Dynamic header title / subtitle by screen:**

| Screen | Title | Subtitle |
|---|---|---|
| Menu | `Navio Plus` | `Online` (with dot) |
| FAQ chat | `FAQ-Agent` | `Online` (with dot) |
| Kontaktform | `Kontakt aufnehmen` | `Antwort in 1–2 Werktagen` (no dot) |
| Info panel | `Über Navio Plus` | *(hidden)* |

---

## 3. Screen 0 — Launcher (FAB)

The collapsed entry point, fixed bottom-right (`bottom-6 right-6`, `z-40`).

| Property | Value |
|---|---|
| Shape / size | `h-14 w-14 rounded-full` (56×56) |
| Color | `bg-ink text-brand-green` (near-black bubble, green icon) |
| Shadow | `shadow-[0_8px_30px_-6px_rgba(149,193,30,0.6)]` — a **green-tinted glow** (the only colored shadow in the widget) |
| Icon | `<Chat>` `h-6 w-6` when closed; `<Close>` when the greeting card is open |
| Enter animation | `opacity 0→1, scale 0.8→1` |
| Tap feedback | `whileTap={{ scale: 0.94 }}` |

The FAB is hidden while the full chat panel is open.

---

## 4. Screen 1 — Greeting Card

A compact welcome shown when the FAB is tapped (before the full panel).

- **Container:** `w-[min(360px,calc(100vw-3rem))] rounded-3xl border border-border bg-surface text-fg overflow-hidden soft-shadow-lg`, `origin-bottom-right`.
- **Greeting block** (`flex items-start gap-3 p-5`):
  - **Icon tile:** `h-12 w-12 rounded-2xl bg-brand-green/15 text-brand-green` holding the bot icon (`h-6 w-6`).
  - **Text:**
    - Title: `font-display text-base font-semibold text-fg` → **"Hi, ich bin Navio 👋🏻"**
    - DE body: `text-sm leading-relaxed text-fg-muted` → *"Dein Guide durch die Sportnavi Welt. Stell deine Fragen und bekomm schnelle Antworten. 💚"*
    - EN body: `text-xs leading-relaxed text-fg-subtle` → *"Your guide through the Sportnavi world — ask away and get answers fast."*
  - **Corner controls:** `h-7 w-7 rounded-full text-fg-subtle hover:bg-fg/5 hover:text-fg` — theme toggle (🌙/☀️) + close (✕).
- **CTA** (`px-5 pb-5`): full-width primary button
  `flex w-full items-center justify-center gap-2 rounded-full bg-brand-green px-4 py-3 text-sm font-medium text-white hover:scale-[1.02]` →
  `<Chat>` **"Mit Navio chatten"** `<ArrowRight>`.
- **Enter/exit:** `opacity 0→1, y 16→0, scale 0.96→1`, `0.2s ease-out`, corner-anchored.

Tapping the CTA swaps the card for the full panel (screen 2).

---

## 5. Screen 2 — Consent Gate (Datenschutzhinweis)

Shown first inside the panel; nothing proceeds without consent.

- **Body:** `flex-1 overflow-y-auto p-4` containing one card:
  `rounded-2xl border border-border bg-surface p-4 soft-shadow`.
- **Card contents (top → bottom):**
  1. **Title row** (`flex items-center gap-2`): orange `<Lock>` `h-4 w-4 text-brand-orange` + `font-display text-sm font-semibold text-fg` → **"Datenschutzhinweis"**.
  2. **Notice paragraph:** `mt-3 text-sm leading-relaxed text-fg-muted` → *"Um dir bestmöglich zu helfen, verarbeitet Navio deine Eingaben. Weitere Details findest du in unserer Datenschutzerklärung."*
  3. **Policy link:** `mt-3 inline-flex items-center gap-1 text-sm font-medium text-fg underline underline-offset-2 hover:text-brand-green` → **"Zur Datenschutzerklärung / Privacy Policy"** + `<ArrowRight>` `h-3.5 w-3.5`.
  4. **Decline hint (conditional):** after "Ablehnen" → `mt-3 text-xs text-brand-orange` → *"Ohne deine Zustimmung kann Navio leider nicht fortfahren."*
  5. **Button row** (`mt-4 flex gap-2`, each `flex-1`):
     - **Zustimmen** (primary): `rounded-full bg-brand-green px-4 py-2 text-sm font-medium text-white hover:scale-[1.02]`
     - **Ablehnen** (secondary): `rounded-full border border-border px-4 py-2 text-sm text-fg hover:border-fg/40`
- **Input bar note:** while unconsented the input placeholder reads *"Bitte Datenschutz akzeptieren"* and both input and send button are disabled (`bg-zinc-200 text-zinc-400` on send).

Consent advances to the **menu** (screen 3).

---

## 6. Screen 3 — Menu (FAQ-Agent · Kontaktformular)

The defining Navio Plus screen. Two large option cards.

- **Body:** `flex-1 overflow-y-auto px-4 py-5`.
- **Intro line:** `px-1 text-sm leading-relaxed text-fg-muted` → *"Wie können wir dir helfen? Wähle einfach aus 👇"*
- **Option cards** (`mt-4 flex flex-col gap-3`), each a button:
  `group flex items-center gap-4 rounded-2xl border border-border bg-surface p-4 text-left soft-shadow transition-all duration-200 hover:-translate-y-0.5`.

| Card | Icon | Title | Body | Accent |
|---|---|---|---|---|
| FAQ-Agent | `<Bot>` | **FAQ-Agent** | *"Stell deine Frage – Navio antwortet sofort, rund um die Uhr."* | **green** |
| Kontaktformular | `<Mail>` | **Kontaktformular** | *"Schreib uns direkt – wir melden uns zeitnah bei dir zurück."* | **orange** |

- **Per-card structure:**
  - **Icon tile:** `h-12 w-12 rounded-2xl` — green card `bg-brand-green/15 text-brand-green`, orange card `bg-brand-orange/15 text-brand-orange`.
  - **Text:** title `font-display text-base font-semibold text-fg`; body `mt-0.5 text-sm leading-snug text-fg-muted`.
  - **Trailing affordance:** `h-8 w-8 rounded-full bg-surface-muted text-fg-subtle` with `<ArrowRight>` — on hover fills with the accent (`group-hover:bg-brand-green`/`…orange`, `group-hover:text-white`).
  - **Hover:** whole card lifts (`-translate-y-0.5`) and border shifts to the accent (`hover:border-brand-green/50` / `…orange/50`).
- **Footnote:** `mt-5 px-1 text-xs leading-relaxed text-fg-subtle` → *"Navio Plus beantwortet Fragen rund um Sportnavi und leitet dich bei Bedarf an unser Team weiter."*
- **Entry animation:** cards stagger in — `opacity 0→1, y 10→0`, `0.25s`, `delay: i * 0.07`. Tap: `whileTap={{ scale: 0.985 }}`.

Selecting **FAQ-Agent** → screen 4a; **Kontaktformular** → screen 4b.

---

## 7. Screen 4a — FAQ Chat

The live FAQ agent, embedded (its own header/footer suppressed — the menu shell provides them). Header shows **"FAQ-Agent" · Online** with a **←** back and **↻** reset.

- **Body:** `flex-1 space-y-2.5 overflow-y-auto px-4 py-4`.

### Message bubbles

| Bubble | Alignment | Classes |
|---|---|---|
| Bot / greeting | left | `max-w-[85%] rounded-2xl rounded-tl-sm bg-surface-muted px-3.5 py-2.5 text-sm text-fg` |
| User | right | `ml-auto max-w-[80%] rounded-2xl rounded-tr-sm bg-user-bubble px-3.5 py-2.5 text-sm text-user-bubble-fg` |
| Error | left | `max-w-[88%] rounded-2xl rounded-tl-sm border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700` |

- Bot text renders as **styled markdown** (links `text-brand-green underline`, disc/decimal lists, `font-semibold` bold, inline `code` on `bg-fg/10`, bordered scrollable tables). The greeting stays plain text to preserve its bilingual line breaks.

### Greeting (first bot bubble)

> Hi, ich bin Navio 👋🏻
> Dein Guide durch die Sportnavi Welt. Wobei kann ich dir helfen?
>
> Hi, I'm Navio 👋🏻
> Your guide through the Sportnavi world. How can I help you?

### Quick replies (shown only before the first user message)

`flex flex-wrap gap-2 pt-1` of chips:
`rounded-full border border-border bg-surface px-3 py-1 text-xs text-fg-muted hover:border-fg/40 hover:text-fg`.
Labels: **"Angebote finden" · "Wie checke ich ein?" · "Partner werden" · "Sportnavi für Firmen"**.

### Typing indicator (while awaiting a reply)

`bg-surface-muted` bubble with three `h-1.5 w-1.5 rounded-full bg-brand-green` dots, opacity-pulsing `[0.3,1,0.3]` over `1s`, staggered `delay: i * 0.18`.

### Message entrance

Each message animates `opacity 0→1, y 8→0` over `0.2s` (via `AnimatePresence`).

### Input bar (constant on chat)

`border-t border-border`, a `flex items-center gap-2 px-3 py-3` form:
- **Text field:** `flex-1 rounded-full bg-surface-muted px-4 py-2 text-sm text-fg placeholder:text-fg-subtle focus:ring-2 focus:ring-brand-green/40` — placeholder *"Frage Navio …"*.
- **Send button:** `h-9 w-9 rounded-full bg-brand-green text-white` with `<Send>` `h-4 w-4`; disabled → `bg-zinc-200 text-zinc-400`.

Reset (↻) clears to the greeting + re-shows quick replies (and, in Navio Plus, returns to the menu with a fresh consent).

---

## 8. Screen 4b — Kontaktformular

A modern, on-brand contact form. Header shows **"Kontakt aufnehmen" · Antwort in 1–2 Werktagen**, with **←** back.

- **Form container:** `flex-1 space-y-5 overflow-y-auto px-4 py-4`.
- **Lead text:** `text-sm leading-relaxed text-fg-muted` → *"Du hast Fragen oder willst direkt loslegen? Schreib uns – wir helfen dir gerne weiter."*

### Shared field style (`fieldBase`)

`w-full rounded-xl border bg-surface-muted px-3.5 py-2.5 text-sm text-fg placeholder:text-fg-subtle focus:outline-none focus:ring-2 focus:ring-brand-green/40`. Default border `border-border`; **error** border `border-brand-orange/60`.

### Labels

`mb-1.5 block font-display text-[13px] font-medium text-fg`; required fields append an orange `*` (`text-brand-orange`).

### Field inventory (top → bottom)

| Field | Control | Notes |
|---|---|---|
| Art der Mitgliedschaft * | **segmented** `grid grid-cols-3 gap-2` of `rounded-xl border px-2 py-2 text-xs font-medium` | active = `border-brand-green bg-brand-green/10 text-fg` |
| Grund der Anfrage * | **select** | `grid-cols-1 sm:grid-cols-2` with next field |
| Thema * | **select** | |
| Kurzbeschreibung * | **select** | |
| Betreff * | text input | placeholder *"Betreff deiner Nachricht"* |
| Name * | text input | placeholder *"Vor- und Nachname"* |
| E-Mail Adresse * | email input | placeholder *"name@beispiel.de"* |
| Telefonnummer | tel input | `grid-cols-1 sm:grid-cols-2`, placeholder *"Optional"* |
| Kundennummer | text input | placeholder *"Optional"* |
| Nachricht * | textarea `rows={4} resize-none` | placeholder *"Deine Nachricht an uns …"* |

- **Select styling:** `fieldBase appearance-none pr-9` + a custom `<ChevronDown>` `h-4 w-4 text-fg-subtle` absolutely positioned right; unselected text is `text-fg-subtle`, selected `text-fg`; disabled → `opacity-60 cursor-not-allowed`.

### Consent checkboxes (`space-y-2.5 pt-1`)

Custom control per row: `label` `flex items-start gap-2.5 text-xs leading-relaxed text-fg-muted` + a `h-5 w-5 rounded-md border` button (`role="checkbox"`):
- unchecked: `border-fg/20 bg-surface`
- checked: `border-brand-green bg-brand-green text-white` with `<Check>` `h-3.5 w-3.5`
- error: `border-brand-orange/70`

Rows: **Datenschutzerklärung** consent, and **Widerrufsbelehrung** acknowledgement (each with an underlined `font-medium text-fg` link).

### Submit + error

- **Submit button:** full-width primary `flex w-full items-center justify-center gap-2 rounded-full bg-brand-green px-4 py-3 text-sm font-medium text-white hover:scale-[1.01]` → **"Jetzt absenden"** + `<Send>`; while sending shows *"Wird gesendet …"*, disabled `opacity-60`.
- **Submit error banner:** `rounded-xl border border-brand-orange/30 bg-brand-orange/5 px-3.5 py-2.5 text-xs text-brand-orange`.

---

## 9. Screen 4c — Success (form submitted)

Replaces the form on success — a centered confirmation.

- **Container:** `flex flex-1 flex-col items-center justify-center px-6 py-10 text-center`.
- **Success badge:** `h-16 w-16 rounded-full bg-brand-green/15 text-brand-green` with `<Check>` `h-8 w-8`, animated in with a **spring** (`stiffness 200, damping 16`, scale `0.7→1`, opacity `0→1`).
- **Headline:** `mt-5 font-display text-xl font-semibold text-fg` → **"Danke, {Vorname}! 🎉"**
- **Body:** `mt-2 max-w-xs text-sm leading-relaxed text-fg-muted` → *"Deine Nachricht ist bei uns eingegangen. Unser Team meldet sich zeitnah bei dir – in der Regel innerhalb von 1–2 Werktagen."*
- **Actions** (`mt-6 flex flex-col gap-2`):
  - **Neue Anfrage senden** (primary): `rounded-full bg-brand-green px-5 py-2 text-sm font-medium text-white hover:scale-[1.02]`
  - **Zurück zum Menü** (text): `rounded-full px-5 py-2 text-sm text-fg-subtle hover:text-fg`

---

## 10. Screen 5 — Info panel ("Über Navio Plus")

Opened via the header ⓘ from the menu; header title becomes **"Über Navio Plus"**, subtitle hidden, left slot shows **←** back.

- **Body:** `flex-1 space-y-4 overflow-y-auto p-5`.
- **Heading block:** `<h3>` `font-display text-base font-semibold text-fg` → **"Über Navio Plus"**; below it EN label `text-xs text-fg-subtle` → *"About Navio Plus"*; then a DE paragraph (`text-sm text-fg-muted`) + EN paragraph (`text-xs text-fg-subtle`) describing the menu experience.
- **Advantages list** (`space-y-2.5`), each item `flex items-start gap-2 text-sm`:
  - **Check tile:** `mt-0.5 h-4 w-4 rounded-full bg-brand-green/20 text-fg` with `<Check>` `h-3 w-3`.
  - **Text:** DE line `text-fg-muted`, EN line below `block text-xs text-fg-subtle`.
  - Items: *"Schreib in jeder Sprache…"*, *"Antwortet nur mit offiziellen Sportnavi-Infos…"*, *"DSGVO-konform – deine Zustimmung vor jeder Nutzung"*, *"FAQ-Agent & Kontaktformular in einem Widget"*.
- **Back button:** `rounded-full bg-fg px-4 py-2 text-sm lowercase text-surface` → **"zurück"** (note the deliberate lowercase, dark pill).

---

## 11. Design tokens (quick reference)

Full details in [WIDGET-DESIGN-GUIDELINES.md](WIDGET-DESIGN-GUIDELINES.md). Essentials to reproduce Navio Plus:

### Colors

| Token | Light | Dark |
|---|---|---|
| `brand-green` (primary) | `#95c11e` | `#95c11e` |
| `brand-orange` (attention) | `#ec6607` | `#ec6607` |
| `ink` (launcher) | `#1a1a1a` | `#1a1a1a` |
| `surface` | `#ffffff` | `#1a1a1a` |
| `surface-muted` (bubbles, fields) | `#efefef` | `#2b2b2b` |
| `fg` / `fg-muted` / `fg-subtle` | `#1a1a1a` / `#52525b` / `#71717a` | `#f4f4f5` / `#b8b8c0` / `#8c8c94` |
| `border` | `rgba(0,0,0,0.08)` | `rgba(255,255,255,0.14)` |
| `user-bubble` / `-fg` | `#efefef` / `#1a1a1a` | `#efefef` / `#1a1a1a` |

Dark mode = add `.theme-dark` on the widget root; all colors are CSS-variable tokens, so one class re-themes everything. Seeded from `prefers-color-scheme`, persisted in `localStorage` (`navio-theme`).

### Typography

- **Outfit** (`font-display`) — titles, names, labels. **Inter** (`font-sans`, default) — body & chat. Weights 300–700, from Google Fonts. Base line-height `1.5`, `antialiased`.
- Scale: titles `text-base font-semibold` (success `text-xl`); body/chat `text-sm leading-relaxed`; hints/EN subtitles `text-xs text-fg-subtle`; labels `text-[13px]`; footer `text-[11px]`.

### Radius

`rounded-full` (buttons, chips, avatars, icon buttons, launcher, send) · `rounded-3xl` (panel, greeting card) · `rounded-2xl` (bubbles, menu cards, consent card, icon tiles) · `rounded-xl` (fields, segmented buttons) · `rounded-md` (checkbox). Bubble tails: bot `rounded-tl-sm`, user `rounded-tr-sm`.

### Shadows

`soft-shadow` = `0 10px 40px rgba(26,26,26,0.06)` (resting cards) · `soft-shadow-lg` = `0 24px 60px -20px rgba(26,26,26,0.18)` (floating panel/card) · launcher glow = `0 8px 30px -6px rgba(149,193,30,0.6)`.

### Icons

One system: inline SVG, `24×24 viewBox`, stroke-based (`fill:none; stroke:currentColor; stroke-width:1.75; round caps/joins`), `currentColor`, `aria-hidden`. Brand marks (`Clover`, `Github`) are the only filled icons. Sizes: `h-6` (launcher/tiles), `h-5` (avatar), `h-4` (header/inline/send), `h-3`–`h-3.5` (tiny).

### Motion (Motion / `motion/react`)

| Interaction | Spec |
|---|---|
| Panel / card enter+exit | `opacity·y16·scale0.96`, `0.2–0.22s ease-out`, `origin-bottom-right` |
| Message appear | `opacity·y8`, `0.2s` |
| Menu cards | staggered, `delay i*0.07` |
| Launcher enter / tap | `scale0.8→1` / `whileTap 0.94` |
| Card tap | `whileTap 0.985` |
| Typing dots | opacity pulse `[0.3,1,0.3]`, `1s`, stagger `i*0.18` |
| Success check | spring `stiffness200 damping16` |
| Button hover | `hover:scale-[1.02]`; card hover `-translate-y-0.5` |

All motion collapses to ~0ms under `prefers-reduced-motion`.

---

## 12. Recreation checklist

To rebuild Navio Plus faithfully elsewhere:

- [ ] **Stack:** React 19 + Vite + **Tailwind v4** (`@tailwindcss/vite`) + **Motion** (`motion`). Markdown in bubbles needs `react-markdown` + `remark-gfm`.
- [ ] **Design foundation:** copy the `@theme` tokens, `.theme-dark` block, `soft-shadow*` utilities, the Google-Fonts `@import` (Inter + Outfit), and the reduced-motion media query (see `index.css`).
- [ ] **Icons:** copy the stroke-based icon set (`icons.tsx`) — match the 1.75px round-stroke style for any new glyph.
- [ ] **Shell:** ink FAB → greeting card → green-header panel (header / scroll-body / privacy-footer).
- [ ] **Flow:** launcher → greeting → consent → **menu (FAQ / Kontakt)** → FAQ chat *or* form → success; ⓘ opens the info panel; ← always returns to menu.
- [ ] **Screens 2–5 & 4a–c:** reproduce the exact classes, copy, and states above.
- [ ] **Theme:** wire a `.theme-dark` toggle seeded from `prefers-color-scheme`, persisted in `localStorage`.
- [ ] **A11y:** every icon button gets an `aria-label`; all inputs get the green focus ring; never rely on color alone for state.

---

*Derived from the live Navio Plus implementation: `ChatWidget.tsx`, `NavioMenuChat.tsx`, `NavioMenu.tsx`, `NavioChat.tsx`, `KontaktForm.tsx`, `icons.tsx`, `index.css`, `useTheme.ts`, and `data/bots.ts` (`id: 'navio-plus'`). Keep this document in sync as the widget evolves.*

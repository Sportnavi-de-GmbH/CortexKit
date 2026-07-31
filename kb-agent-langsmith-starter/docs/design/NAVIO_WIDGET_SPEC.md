# Navio — Widget Design Specification

> **Screen-by-screen design reference for the Navio FAQ Agent widget** (the plain, chat-first bot).
>
> This document describes **every screen the Navio widget opens**, its layout, all UI elements, colors, typography, spacing, navigation flow, and animations — everything needed to faithfully recreate it in another project. It documents *design and UI only*; business logic, API wiring, and agent behavior are out of scope.
>
> Companion docs: [WIDGET-DESIGN-GUIDELINES.md](WIDGET-DESIGN-GUIDELINES.md) (the shared design *system* — raw tokens, component rules) and [NAVIO_PLUS_WIDGET_SPEC.md](NAVIO_PLUS_WIDGET_SPEC.md) (the *menu* variant). This file is the base **chat-first** flow.

---

## 0. What Navio is (design-wise)

Navio is the **chat-first** widget: after consent it drops **straight into the FAQ chat** — no menu, no branching. (Navio Plus adds a menu; that's the only structural difference.)

- **Bot identity:** name `Navio`, icon `Bot`, header title *"Navio — Sportnavi Guide"*.
- **Source components:** `ChatWidget` (launcher shell) → `NavioChat` (the full chat, using its **own** header + footer).
- **Signature look:** white rounded panel, **Sportnavi-green header**, ink launcher with a green glow, soft shadows, pill buttons, bilingual (DE/EN) copy.

---

## 1. Screen inventory & navigation flow

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
        │  3. FAQ Chat       │  greeting · quick replies · input
        └─────────┬──────────┘
             ⓘ    │  (toggles over the body)
        ┌─────────▼──────────┐
        │  4. Info panel     │  "Über Navio" → "zurück zum Chat"
        └────────────────────┘
```

**Key flow facts (vs. Navio Plus):**
- **No menu step** — consent leads directly to chat.
- **No back-arrow** in the header (there's nowhere to go back to). Instead, the **info panel** is a body-level overlay toggled by the ⓘ button, with an in-body "zurück zum Chat" button.
- **Reset (↻)** clears the chat back to the greeting **and** re-requires consent (returns to screen 2 fresh).

**Header controls (all always visible on chat):** 🌙/☀️ theme · ⓘ info · ↻ reset · ✕ close.

---

## 2. Global shell

- **Panel container:** `flex flex-col overflow-hidden rounded-3xl border border-border bg-surface text-fg`
  - Floating size: `h-[min(560px,72vh)] w-[min(380px,calc(100vw-3rem))]`, `origin-bottom-right`, `soft-shadow-lg`.
- **Vertical stack:** Header (fixed) → Body (`flex-1 overflow-y-auto`, only scroll region) → Input (fixed) → Privacy footer (fixed).
- **Footer (constant):** `border-t border-border bg-surface px-4 py-2 text-center` → link `Datenschutz · Privacy Policy` (`text-[11px] text-fg-subtle underline hover:text-fg`, new tab).

### Header (`bg-brand-green px-4 py-3 text-white`, `flex items-center gap-3`)

- **Avatar** (`h-9 w-9 rounded-full bg-white text-brand-green`) holding `<Bot>` (`h-5 w-5`). *(Navio has no back-arrow variant — the avatar is always shown.)*
- **Title block** (`min-w-0 flex-1`): title `font-display text-sm font-semibold leading-tight truncate` → **"Navio — Sportnavi Guide"**; subtitle row `text-xs text-white/85` → `h-1.5 w-1.5 rounded-full bg-white` dot + **"Online"**.
- **Controls:** round `h-8 w-8 rounded-full bg-white/15 hover:bg-white/30 transition-colors` buttons (each `h-4 w-4` icon + `aria-label`): theme toggle → info → reset → close.

---

## 3. Screen 0 — Launcher (FAB)

Collapsed entry point, fixed bottom-right (`bottom-6 right-6`, `z-40`).

| Property | Value |
|---|---|
| Shape / size | `h-14 w-14 rounded-full` (56×56) |
| Color | `bg-ink text-brand-green` |
| Shadow | `shadow-[0_8px_30px_-6px_rgba(149,193,30,0.6)]` — green-tinted glow |
| Icon | `<Chat>` `h-6 w-6` (→ `<Close>` when the greeting card is open) |
| Enter / tap | `opacity 0→1, scale 0.8→1` / `whileTap scale 0.94` |

Hidden while the full chat panel is open.

---

## 4. Screen 1 — Greeting Card

Compact welcome shown when the FAB is tapped.

- **Container:** `w-[min(360px,calc(100vw-3rem))] rounded-3xl border border-border bg-surface text-fg overflow-hidden soft-shadow-lg`, `origin-bottom-right`.
- **Greeting block** (`flex items-start gap-3 p-5`):
  - **Icon tile:** `h-12 w-12 rounded-2xl bg-brand-green/15 text-brand-green` + bot icon `h-6 w-6`.
  - Title `font-display text-base font-semibold text-fg` → **"Hi, ich bin Navio 👋🏻"**
  - DE body `text-sm leading-relaxed text-fg-muted` → *"Dein Guide durch die Sportnavi Welt. Stell deine Fragen und bekomm schnelle Antworten. 💚"*
  - EN body `text-xs leading-relaxed text-fg-subtle` → *"Your guide through the Sportnavi world — ask away and get answers fast."*
  - **Corner controls:** `h-7 w-7 rounded-full text-fg-subtle hover:bg-fg/5 hover:text-fg` — theme toggle + close.
- **CTA** (`px-5 pb-5`): full-width `rounded-full bg-brand-green px-4 py-3 text-sm font-medium text-white hover:scale-[1.02] flex items-center justify-center gap-2` → `<Chat>` **"Mit Navio chatten"** `<ArrowRight>`.
- **Enter/exit:** `opacity·y16·scale0.96`, `0.2s ease-out`, corner-anchored.

---

## 5. Screen 2 — Consent Gate (Datenschutzhinweis)

Shown first inside the panel; chat is disabled until consent.

- **Body:** `flex-1 overflow-y-auto p-4` → one card `rounded-2xl border border-border bg-surface p-4 soft-shadow`:
  1. **Title row** (`flex items-center gap-2`): orange `<Lock>` `h-4 w-4 text-brand-orange` + `font-display text-sm font-semibold text-fg` → **"Datenschutzhinweis"**.
  2. **Notice** `mt-3 text-sm leading-relaxed text-fg-muted` → *"Um dir bestmöglich zu helfen, verarbeitet Navio deine Eingaben. Weitere Details findest du in unserer Datenschutzerklärung."*
  3. **Policy link** `mt-3 inline-flex items-center gap-1 text-sm font-medium text-fg underline underline-offset-2 hover:text-brand-green` → **"Zur Datenschutzerklärung / Privacy Policy"** + `<ArrowRight>` `h-3.5 w-3.5`.
  4. **Decline hint (conditional)** after Ablehnen → `mt-3 text-xs text-brand-orange` → *"Ohne deine Zustimmung kann Navio leider nicht antworten."*
  5. **Buttons** (`mt-4 flex gap-2`, each `flex-1`):
     - **Zustimmen** — `rounded-full bg-brand-green px-4 py-2 text-sm font-medium text-white hover:scale-[1.02]`
     - **Ablehnen** — `rounded-full border border-border px-4 py-2 text-sm text-fg hover:border-fg/40`
- **Input bar (disabled state):** placeholder *"Bitte Datenschutz akzeptieren"*, input + send disabled (send → `bg-zinc-200 text-zinc-400`).

Consent → straight to **chat** (screen 3).

---

## 6. Screen 3 — FAQ Chat

The core screen. Body `flex-1 space-y-2.5 overflow-y-auto px-4 py-4`.

### Message bubbles

| Bubble | Alignment | Classes |
|---|---|---|
| Bot / greeting | left | `max-w-[85%] rounded-2xl rounded-tl-sm bg-surface-muted px-3.5 py-2.5 text-sm text-fg` |
| User | right | `ml-auto max-w-[80%] rounded-2xl rounded-tr-sm bg-user-bubble px-3.5 py-2.5 text-sm text-user-bubble-fg` |
| Error | left | `max-w-[88%] rounded-2xl rounded-tl-sm border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700` |

Bot replies render as **styled markdown** (links `text-brand-green underline`, disc/decimal lists, `font-semibold` bold, inline `code` on `bg-fg/10`, bordered scrollable tables). The greeting stays plain text to preserve its bilingual line breaks. Each message enters `opacity 0→1, y 8→0` over `0.2s`.

### Greeting (first bot bubble)

> Hi, ich bin Navio 👋🏻
> Dein Guide durch die Sportnavi Welt. Wobei kann ich dir helfen?
>
> Hi, I'm Navio 👋🏻
> Your guide through the Sportnavi world. How can I help you?

### Quick replies (only before the first user message)

`flex flex-wrap gap-2 pt-1` of chips: `rounded-full border border-border bg-surface px-3 py-1 text-xs text-fg-muted hover:border-fg/40 hover:text-fg`.
Labels: **"Angebote finden" · "Wie checke ich ein?" · "Partner werden" · "Sportnavi für Firmen"**.

### Typing indicator

`bg-surface-muted` bubble with three `h-1.5 w-1.5 rounded-full bg-brand-green` dots pulsing opacity `[0.3,1,0.3]` over `1s`, staggered `delay: i * 0.18`.

### Inline contact form (optional)

When a reply contains the `[[KONTAKTFORMULAR]]` marker (Navio One workflow), the widget renders the **real Kontaktformular** inline as a full-width bubble (`w-full rounded-2xl border border-border bg-surface soft-shadow`). Superseded forms collapse to a muted stub — *"Kontaktformular geschlossen · contact form closed"* (`rounded-tl-sm bg-surface-muted text-xs text-fg-subtle`). Form field styling matches [NAVIO_PLUS_WIDGET_SPEC.md §8](NAVIO_PLUS_WIDGET_SPEC.md). *(Standard Navio has no menu-driven form; this is reply-triggered only.)*

### Input bar (constant)

`border-t border-border`, `flex items-center gap-2 px-3 py-3` form:
- **Text field:** `flex-1 rounded-full bg-surface-muted px-4 py-2 text-sm text-fg placeholder:text-fg-subtle focus:ring-2 focus:ring-brand-green/40` — placeholder *"Frage Navio …"*.
- **Send button:** `h-9 w-9 rounded-full bg-brand-green text-white` + `<Send>` `h-4 w-4`; disabled → `bg-zinc-200 text-zinc-400`.

---

## 7. Screen 4 — Info panel ("Über Navio")

Toggled by the header ⓘ — it **replaces the chat body** (an overlay within the panel; the header stays, the input hides while it's open).

- **Body:** `flex-1 space-y-4 overflow-y-auto p-5`.
- **Heading block:** `<h3>` `font-display text-base font-semibold text-fg` → **"Über Navio"**; EN label `text-xs text-fg-subtle` → *"About Navio"*; then a DE paragraph (`mt-2 text-sm text-fg-muted`) + EN paragraph (`text-xs text-fg-subtle`). Default copy: *"Navio ist dein freundlicher Guide durch Sportnavi – Deutschlands Firmenfitness-Netzwerk…"* / *"Navio is your friendly guide through Sportnavi — Germany's corporate-fitness network…"*
- **Advantages list** (`space-y-2.5`), each `flex items-start gap-2 text-sm`:
  - **Check tile:** `mt-0.5 h-4 w-4 rounded-full bg-brand-green/20 text-fg` + `<Check>` `h-3 w-3`.
  - DE line `text-fg-muted`; EN line below `block text-xs text-fg-subtle`.
  - Items: *"Schreib in jeder Sprache – Navio antwortet in deiner"*, *"Antwortet nur mit offiziellen Sportnavi-Infos – erfindet nichts"*, *"DSGVO-konform – deine Zustimmung vor jedem Chat"*, *"Hilft Mitgliedern, Firmen & Partnern – rund um die Uhr"*.
- **Privacy note:** `text-xs text-fg-subtle` with an inline underlined *"Datenschutzerklärung / Privacy Policy"* link.
- **Back button:** `rounded-full bg-fg px-4 py-2 text-sm lowercase text-surface` → **"zurück zum Chat"** (deliberate lowercase, dark pill).

---

## 8. Design tokens (quick reference)

Full details in [WIDGET-DESIGN-GUIDELINES.md](WIDGET-DESIGN-GUIDELINES.md).

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

Dark mode = `.theme-dark` on the widget root (CSS-variable token swap). Seeded from `prefers-color-scheme`, persisted in `localStorage` (`navio-theme`).

### Typography

**Outfit** (`font-display`) for titles/labels, **Inter** (`font-sans`, default) for body/chat; weights 300–700, Google Fonts, base line-height `1.5`, `antialiased`. Scale: titles `text-base font-semibold`; body/chat `text-sm leading-relaxed`; hints/EN subtitles `text-xs text-fg-subtle`; footer `text-[11px]`.

### Radius

`rounded-full` (buttons, chips, avatars, icon buttons, launcher, send) · `rounded-3xl` (panel, greeting card) · `rounded-2xl` (bubbles, consent card, tiles) · `rounded-xl` (fields) · bubble tails bot `rounded-tl-sm` / user `rounded-tr-sm`.

### Shadows

`soft-shadow` `0 10px 40px rgba(26,26,26,0.06)` · `soft-shadow-lg` `0 24px 60px -20px rgba(26,26,26,0.18)` · launcher glow `0 8px 30px -6px rgba(149,193,30,0.6)`.

### Icons

Inline SVG, `24×24`, stroke-based (`fill:none; stroke:currentColor; stroke-width:1.75; round caps/joins`), `currentColor`, `aria-hidden`. Sizes: `h-6` (launcher/tiles), `h-5` (avatar), `h-4` (header/send), `h-3`–`h-3.5` (tiny).

### Motion (Motion / `motion/react`)

| Interaction | Spec |
|---|---|
| Panel / card enter+exit | `opacity·y16·scale0.96`, `0.2–0.22s ease-out`, `origin-bottom-right` |
| Message appear | `opacity·y8`, `0.2s` |
| Launcher enter / tap | `scale0.8→1` / `whileTap 0.94` |
| Typing dots | opacity pulse `[0.3,1,0.3]`, `1s`, stagger `i*0.18` |
| Button hover | `hover:scale-[1.02]` |

All motion collapses to ~0ms under `prefers-reduced-motion`.

---

## 9. Recreation checklist

- [ ] **Stack:** React 19 + Vite + **Tailwind v4** (`@tailwindcss/vite`) + **Motion**. Markdown bubbles need `react-markdown` + `remark-gfm`.
- [ ] **Design foundation:** copy the `@theme` tokens, `.theme-dark` block, `soft-shadow*` utilities, Google-Fonts `@import` (Inter + Outfit), reduced-motion media query (see `index.css`).
- [ ] **Icons:** copy the stroke-based set (`icons.tsx`).
- [ ] **Shell:** ink FAB → greeting card → green-header panel (header / scroll-body / input / privacy-footer).
- [ ] **Flow:** launcher → greeting → consent → **chat** (no menu). ⓘ opens the info overlay; ↻ resets to greeting + re-consent.
- [ ] **Screens 2–4:** reproduce exact classes, copy, and states above.
- [ ] **Theme:** `.theme-dark` toggle seeded from `prefers-color-scheme`, persisted in `localStorage`.
- [ ] **A11y:** every icon button `aria-label`; green focus ring on inputs; never color-only state.

---

*Derived from the live Navio implementation: `ChatWidget.tsx`, `NavioChat.tsx`, `KontaktForm.tsx`, `icons.tsx`, `index.css`, `useTheme.ts`, and `data/bots.ts` (`id: 'navio'`). Keep in sync as the widget evolves.*

# Widget Design Guidelines

> **Single source of truth for the Navio widget's UI design.**
>
> This document captures the complete visual design language of the Navio chat widget so that
> every new widget we build looks like it belongs to the same family — same palette, typography,
> spacing, elevation, and motion — without re-deriving it each time. It documents *appearance
> only*; functionality (state, API calls, agent logic) is intentionally out of scope.
>
> **Canonical standard.** Any change to the Navio widget's look must conform to this document.
> When the widget evolves, update this file first so it stays authoritative. In this repo the
> widget UI lives in `app/widget/page.tsx`, `components/` (e.g. `ChatPanel.tsx`, `SessionBar.tsx`),
> and `app/globals.css`; the embed launcher is `public/launcher.js`.

---

## 1. Design Philosophy

The widget is **calm, trustworthy, and on-brand**. Five principles drive every decision:

1. **Brand-first, restraint-second.** The interface is built almost entirely from a tiny official palette (green, orange, ink, white + neutral grays). Color is used as a *signal*, not decoration — a single green accent carries primary intent; everything else is quiet neutral.
2. **Token-driven theming.** Components never reference raw hex. They reference *semantic tokens* (`surface`, `fg`, `border`, …). Light and dark modes are the exact same components — dark mode is a one-class token swap, nothing is hand-inverted.
3. **Soft, friendly geometry.** Generous rounding (pills and large radii), gentle diffuse shadows, and light borders. Nothing is sharp, heavy, or harsh.
4. **Bilingual, human tone.** Copy leads in German, follows in English, at a smaller/lighter weight. The UI leaves room for two-line labels and a warm, informal voice (emoji used sparingly).
5. **Accessible by construction.** Every foreground/background pair clears WCAG contrast, motion respects `prefers-reduced-motion`, all controls are real focusable buttons with `aria-label`s, and dark mode is *tonal* (not inverted) per Material/WCAG guidance.

**The feeling to reproduce:** a lightweight, premium messaging surface that feels like a native part of a modern SaaS product — not a bolted-on chatbot.

---

## 2. Layout & Spacing System

### Container dimensions

| Surface | Width | Height |
|---|---|---|
| Chat panel | `min(380px, calc(100vw - 3rem))` | `min(560px, 72vh)` |
| Greeting card | `min(360px, calc(100vw - 3rem))` | auto |
| Launcher bubble (FAB) | `56px` (`h-14 w-14`) | `56px` |

All floating surfaces are anchored **bottom-right** with a `1.5rem` (`bottom-6 right-6`) offset from the viewport edge, in a bottom-aligned, right-aligned flex column with `gap-3` between stacked pieces.

### The panel is a vertical stack

Every full widget is a `flex flex-col overflow-hidden` column of up to four regions:

```
┌─────────────────────────────┐
│ Header      (fixed height)  │  bg-brand-green, px-4 py-3
├─────────────────────────────┤
│ Body        (flex-1, scroll)│  the only region that scrolls
├─────────────────────────────┤
│ Input       (fixed)         │  border-t, px-3 py-3
├─────────────────────────────┤
│ Privacy footer (fixed)      │  border-t, px-4 py-2, centered
└─────────────────────────────┘
```

Only the body scrolls (`flex-1 overflow-y-auto`). Header, input, and footer stay pinned.

### Spacing scale (Tailwind units, 1 unit = 0.25rem = 4px)

Stay on this ladder — do not invent in-between values:

| Token | px | Typical use |
|---|---|---|
| `gap-1` / `gap-1.5` | 4 / 6 | icon-to-label, status dot |
| `gap-2` / `gap-2.5` | 8 / 10 | button rows, list items, message stack |
| `gap-3` / `gap-4` | 12 / 16 | header cluster, card content, menu cards |
| `p-4` | 16 | consent card, menu body, chat body padding |
| `p-5` | 20 | info panel, greeting card |
| `px-4 py-3` | 16 / 12 | header, CTA buttons |
| `px-3.5 py-2.5` | 14 / 10 | chat bubbles, form fields |
| `py-2` / `py-2.5` / `py-3` | 8 / 10 / 12 | button heights |

**Rule of thumb:** outer chrome uses `p-4`/`p-5`; inline content (bubbles, fields) uses `px-3.5 py-2.5`; vertical rhythm between message-like items is `space-y-2.5`.

---

## 3. Color Palette & Usage

### Brand constants (identical in both themes — never re-theme these)

| Name | Hex | Role |
|---|---|---|
| `brand-green` | `#95c11e` | **Primary.** All primary actions, avatars, links, accents, "online" signals |
| `brand-orange` | `#ec6607` | **Secondary / attention.** Required-field markers, warnings, the "contact" path, gradient partner |
| `ink` | `#1a1a1a` | Near-black. Launcher background, high-contrast text/surfaces |

### Semantic tokens

Components reference **these**, not the hex above. Values swap under `.theme-dark`:

| Token | Light | Dark | Use |
|---|---|---|---|
| `surface` | `#ffffff` | `#1a1a1a` | Panels, cards, sheets |
| `surface-muted` | `#efefef` | `#2b2b2b` | Bot bubbles, inputs, form fields (team-approved grey) |
| `fg` | `#1a1a1a` | `#f4f4f5` | Primary text |
| `fg-muted` | `#52525b` | `#b8b8c0` | Secondary/body text |
| `fg-subtle` | `#71717a` | `#8c8c94` | Tertiary text, hints, placeholders |
| `border` | `rgba(0,0,0,0.08)` | `rgba(255,255,255,0.14)` | All hairline borders |
| `user-bubble` | `#efefef` | `#efefef` | Outgoing message background |
| `user-bubble-fg` | `#1a1a1a` | `#1a1a1a` | Outgoing message text |

### Usage rules

- **One primary color per surface.** Green is the single call-to-action color. Do not add a second competing accent.
- **Orange = attention, not action.** Reserve orange for the privacy `Lock` icon, required `*` markers, validation errors, and the "Kontaktformular" secondary path. Never use orange for the main send/submit button (that's always green).
- **Tints via opacity, not new colors.** Soft accent fills use `brand-green/15`, `brand-green/20`, `brand-green/10`; orange the same (`brand-orange/15`). White overlays on the green header use `bg-white/15` → `hover:bg-white/30`.
- **Errors** use the standard red scale for hard errors (`border-red-200 bg-red-50 text-red-700`) and `brand-orange` for soft form-validation states.
- **Dark mode is tonal, never inverted.** Surfaces step `#1a1a1a` → `#2b2b2b`; text steps down from `#f4f4f5`. Brand green/orange are bright enough to survive on both, so they stay put.

---

## 4. Typography

### Font families

| Family | Stack | Use |
|---|---|---|
| **Outfit** (`font-display`) | `"Outfit", ui-sans-serif, system-ui` | Headings, titles, names, labels — anything that should feel branded |
| **Inter** (`font-sans`, default) | `"Inter", ui-sans-serif, system-ui` | Body copy, chat text, paragraphs |

Both loaded from Google Fonts at weights **300, 400, 500, 600, 700**. Base line-height `1.5`, always `antialiased`.

### Type scale & pairings

| Element | Classes | Notes |
|---|---|---|
| Card / section title | `font-display text-base font-semibold` | Outfit, 16px |
| Success headline | `font-display text-xl font-semibold` | 20px |
| Header title | `font-display text-sm font-semibold leading-tight` | Truncates with `truncate min-w-0` |
| Body / chat text | `text-sm leading-relaxed` | 14px, Inter |
| Secondary body | `text-sm text-fg-muted` | |
| Hints / captions / EN subtitles | `text-xs text-fg-subtle` | 12px |
| Micro (footer link) | `text-[11px]` | Privacy link only |
| Form labels | `font-display text-[13px] font-medium` | |

### Typographic conventions

- **Bilingual hierarchy:** German line in `text-fg`/`text-fg-muted` (`text-sm`), English line directly below in `text-xs text-fg-subtle`. The primary language is always larger/darker.
- **Weight for emphasis, not size jumps.** Most of the UI lives at `text-sm`; hierarchy comes from weight (`font-semibold`) and color token (`fg` vs `fg-muted` vs `fg-subtle`), not many font sizes.
- **Lowercase micro-CTAs.** Secondary "back" buttons use `lowercase` deliberately (e.g. *"zurück zum chat"*) for a soft, informal tone.
- `leading-relaxed` on all multi-line body copy; `leading-tight`/`leading-snug` only for dense two-line labels.

---

## 5. Border Radius, Shadows & Elevation

### Radius ladder

| Radius | Value | Applied to |
|---|---|---|
| `rounded-full` | pill | Buttons, quick-reply chips, avatars, icon buttons, launcher, status dot, send button |
| `rounded-3xl` | 24px | Outer panel & greeting card |
| `rounded-2xl` | 16px | Chat bubbles, menu option cards, consent card, icon tiles |
| `rounded-xl` | 12px | Inputs, form fields, segmented-control buttons |
| `rounded-md` | 6px | Checkbox |
| `rounded-lg` | 8px | Markdown table wrapper |

**Bubble tails:** message bubbles soften one corner to imply direction — bot bubbles use `rounded-tl-sm` (tail top-left), user bubbles use `rounded-tr-sm` (tail top-right). Everything else stays `rounded-2xl`.

### Shadows (elevation)

Only two named elevations exist — soft, wide, low-opacity. Never use hard/dark drop shadows.

| Utility | Value | Use |
|---|---|---|
| `soft-shadow` | `0 10px 40px rgba(26,26,26,0.06)` | Resting cards inside the panel (consent card, menu cards, form bubble) |
| `soft-shadow-lg` | `0 24px 60px -20px rgba(26,26,26,0.18)` | Floating surfaces (open chat panel, greeting card) |
| FAB glow | `0 8px 30px -6px rgba(149,193,30,0.6)` | Launcher only — a **green-tinted** glow, the one branded shadow |

**Elevation logic:** the higher something floats above the page, the larger/softer its shadow. The launcher gets a colored glow because it's the brand's single "hello" moment; everything else uses neutral ink-based shadow.

---

## 6. Component Styling

### 6.1 Header
`bg-brand-green px-4 py-3 text-white`, a horizontal `flex items-center gap-3`.
- **Leading slot:** either a `h-9 w-9 rounded-full bg-white text-brand-green` avatar (inverse fill) holding the bot icon, or a back-arrow icon button.
- **Title block:** `flex-1 min-w-0` → title (`font-display text-sm font-semibold`, `truncate`) + status row (`text-xs text-white/85`) with a `h-1.5 w-1.5 rounded-full bg-white` "online" dot.
- **Action buttons:** right-aligned cluster of round `h-8 w-8 rounded-full bg-white/15 hover:bg-white/30` icon buttons (theme toggle, info, reset, close).

### 6.2 Icon buttons
Always circular. On the green header: `h-8 w-8 rounded-full bg-white/15 hover:bg-white/30 text-white`. On light surfaces (greeting card): `h-7 w-7 rounded-full text-fg-subtle hover:bg-fg/5 hover:text-fg`. All have `transition-colors` and an `aria-label`.

### 6.3 Buttons

| Type | Classes | Use |
|---|---|---|
| **Primary** | `rounded-full bg-brand-green px-4 py-2 text-sm font-medium text-white transition-transform hover:scale-[1.02]` | Zustimmen, Send, Submit, main CTA |
| **Primary (large CTA)** | same + `py-3 w-full flex items-center justify-center gap-2` + icon | "Mit Navio chatten", "Jetzt absenden" |
| **Secondary / outline** | `rounded-full border border-border px-4 py-2 text-sm text-fg hover:border-fg/40` | Ablehnen |
| **Tertiary / text** | `rounded-full px-5 py-2 text-sm text-fg-subtle hover:text-fg` | "Zurück zum Menü" |
| **Dark pill** | `rounded-full bg-fg px-4 py-2 text-sm lowercase text-surface` | "zurück zum chat" |
| **Send (icon)** | `h-9 w-9 rounded-full bg-brand-green text-white`, disabled → `bg-zinc-200 text-zinc-400` | |

**Disabled state:** either `disabled:opacity-60` (with `cursor-not-allowed`) or the explicit muted zinc swap on the send button. Primary buttons animate on hover via `hover:scale-[1.02]` (subtle lift), never a color change.

### 6.4 Chat bubbles

| Bubble | Classes |
|---|---|
| Bot / intro | `max-w-[85%] rounded-2xl rounded-tl-sm bg-surface-muted px-3.5 py-2.5 text-sm text-fg` |
| User | `ml-auto max-w-[80%] rounded-2xl rounded-tr-sm bg-user-bubble px-3.5 py-2.5 text-sm text-user-bubble-fg` |
| Error | `max-w-[88%] rounded-2xl rounded-tl-sm border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700` |
| Form (embedded card) | `w-full rounded-2xl border border-border bg-surface soft-shadow` |

Bot bubbles align left, user bubbles push right with `ml-auto`. Bubbles stack with `space-y-2.5` and `whitespace-pre-wrap` where raw text needs its line breaks preserved.

### 6.5 Typing indicator
Three `h-1.5 w-1.5 rounded-full bg-brand-green` dots in a `bg-surface-muted` bubble, each pulsing opacity `[0.3, 1, 0.3]` over `1s`, staggered by `delay: i * 0.18`.

### 6.6 Cards & tiles
- **Greeting card / menu card:** `rounded-2xl border border-border bg-surface p-4 soft-shadow`, with a `h-12 w-12 rounded-2xl` icon tile (accent-tinted, e.g. `bg-brand-green/15 text-brand-green`), a title/body text block, and a trailing `h-8 w-8 rounded-full` arrow affordance.
- **Hover:** menu cards lift with `hover:-translate-y-0.5`, border shifts to the accent (`hover:border-brand-green/50`), and the trailing arrow fills with the accent color on `group-hover`.

### 6.7 Inputs & form fields
Shared base: `w-full rounded-xl border bg-surface-muted px-3.5 py-2.5 text-sm text-fg placeholder:text-fg-subtle focus:outline-none focus:ring-2 focus:ring-brand-green/40`.
- **Chat input** is the exception — `rounded-full` (pill), same muted fill and green focus ring.
- **Focus:** always a 2px `brand-green/40` ring, never a default browser outline.
- **Error:** border swaps to `border-brand-orange/60` (fields) — never a jarring pure red on forms.
- **Select:** same base + custom `ChevronDown` icon absolutely positioned right, native chevron removed via `appearance-none`.
- **Segmented control:** `grid grid-cols-3 gap-2` of `rounded-xl border px-2 py-2 text-xs font-medium`; active = `border-brand-green bg-brand-green/10 text-fg`.
- **Checkbox:** custom `h-5 w-5 rounded-md border` button; checked = `border-brand-green bg-brand-green text-white` with a `Check` icon.
- **Labels:** `font-display text-[13px] font-medium text-fg`; required marker is an orange `*`.

### 6.8 Quick-reply chips
`rounded-full border border-border bg-surface px-3 py-1 text-xs text-fg-muted hover:border-fg/40 hover:text-fg`, wrapped in `flex flex-wrap gap-2`.

### 6.9 Launcher (FAB)
`h-14 w-14 rounded-full bg-ink text-brand-green` with the green glow shadow. Holds the `Chat` icon (or `Close` when expanded). Ink background + green icon is the signature launcher look.

### 6.10 Consent gate
A `rounded-2xl border border-border bg-surface p-4 soft-shadow` card: orange `Lock` icon + `font-display text-sm font-semibold` title, muted notice paragraph, an underlined policy link with a trailing `ArrowRight`, then a two-button row (green Zustimmen / outline Ablehnen, `flex gap-2` each `flex-1`).

---

## 7. Icons & Imagery

- **One icon system.** All icons are custom, inline, `24×24` `viewBox`, **stroke-based** (`fill="none" stroke="currentColor" strokeWidth={1.75}`), with `strokeLinecap="round" strokeLinejoin="round"`. They inherit color via `currentColor` and are `aria-hidden`.
- **Brand marks are filled** (the four-petal `Clover`, `Github`) — the only filled icons.
- **Sizes:** `h-6 w-6` (launcher, card tiles), `h-5 w-5` (avatar), `h-4 w-4` (header buttons, inline actions, send), `h-3.5`/`h-3` (tiny inline checks, arrows).
- **No raster imagery, no stock photos, no external icon libraries.** The rounded 1.75px stroke weight is what makes the set feel cohesive — match it exactly for any new glyph.
- **Emoji** are allowed sparingly in copy (👋🏻 💚 🎉 👇) as warmth, never as functional icons.

---

## 8. Responsive Design

- **Mobile-first clamping.** Every floating surface width is `min(fixed, calc(100vw - 3rem))` and the panel height is `min(560px, 72vh)` — so it never exceeds the viewport and always keeps a `1.5rem` gutter.
- **Fluid form grids:** two-up fields use `grid-cols-1 sm:grid-cols-2` — single column on narrow widths, side-by-side from the `sm` breakpoint.
- **Truncation over wrapping** for fixed-height chrome (header title uses `truncate` + `min-w-0`); body copy is free to wrap.
- **Scrollable overflow, never page-breaking.** Wide content (markdown tables) scrolls inside its own `overflow-x-auto` container rather than stretching the widget.
- **Shadow-DOM isolation** (embed): the widget mounts in a sealed shadow root so host-page CSS can't leak in and ours can't leak out — layout is fully self-contained.

---

## 9. Animation & Transitions

Powered by **Motion** (`motion/react`). Keep motion *quick, subtle, and purposeful*.

| Interaction | Spec |
|---|---|
| Panel / card enter | `opacity 0→1, y 16→0, scale 0.96→1`, `0.2–0.22s ease-out`, `origin-bottom-right` |
| Panel / card exit | reverse of enter (via `AnimatePresence`) |
| Message appear | `opacity 0→1, y 8→0`, `0.2s` |
| Menu cards | staggered enter, `delay: i * 0.07` |
| Launcher enter | `opacity + scale 0.8→1` |
| Tap feedback | `whileTap={{ scale: 0.94 }}` (launcher) / `0.985` (cards) |
| Typing dots | opacity pulse `[0.3,1,0.3]`, `1s` loop, staggered `i * 0.18` |
| Success check | spring, `stiffness 200, damping 16` |
| Hover lifts | `transition-transform hover:scale-[1.02]` (buttons), `hover:-translate-y-0.5` (cards) |
| Color hovers | `transition-colors` (always, for icon buttons & links) |

**Rules:** durations stay `0.2–0.25s`; springs only for celebratory moments (success). Panels grow *from the corner they're anchored to* (`origin-bottom-right`). **Always** respect `prefers-reduced-motion` — a global media query collapses all animation/transition durations to `~0ms`.

---

## 10. Visual Hierarchy & Accessibility

**Hierarchy is built from four levers, in order:** (1) color token (`fg` > `fg-muted` > `fg-subtle`), (2) font weight (`semibold` vs `normal`), (3) the display font for titles, (4) size — used last and sparingly. A single green accent draws the eye to the one primary action on any surface.

**Accessibility musts:**
- Every interactive element is a real `<button>`/`<a>` with an `aria-label` (icon-only buttons) or visible text.
- Custom checkbox exposes `role="checkbox"` + `aria-checked`.
- Focus is always visible — a `focus:ring-2 focus:ring-brand-green/40` ring, never `outline: none` without a replacement.
- Contrast: all token pairs clear WCAG 4.5:1 (primary text) / 3:1 (secondary). Dark mode is tonal so contrast holds in both themes.
- `prefers-reduced-motion` and `prefers-color-scheme` are both honored (the latter seeds the initial theme).
- Links open with `target="_blank" rel="noreferrer"`.
- Never rely on color alone — errors pair the orange/red with an icon or text; the "online" state pairs the dot with the word "Online".

---

## 11. Reusable Patterns & Best Practices

- **Token-only styling.** New components reference `bg-surface`, `text-fg`, `border-border`, etc. — *never* raw hex. This is what makes dark mode free.
- **Accent-as-data pattern.** When a component varies by category (e.g. green FAQ vs orange contact), define an `accent` object (`{ tile, hover, ring }`) and interpolate — don't hardcode per-branch class strings.
- **`group` + `group-hover`** for compound card hovers (border, arrow fill, lift all react together).
- **Pill everything interactive.** Buttons, chips, avatars, icon buttons, launcher → `rounded-full`. Containers → `rounded-2xl`/`3xl`. Fields → `rounded-xl`.
- **Two shadows only.** `soft-shadow` (resting) and `soft-shadow-lg` (floating). Reach for a colored glow *only* for the launcher.
- **Bilingual text blocks:** primary language larger/darker, secondary smaller/`fg-subtle` directly beneath.
- **Consistent bubble grammar:** left/`rounded-tl-sm` = system, right/`ml-auto`/`rounded-tr-sm` = user.
- **Embeddable by default:** components accept an `embedded` flag to drop their own header/footer/border when a host shell provides them — design new components to compose the same way.

---

## 12. Do's and Don'ts

### ✅ Do
- Use `brand-green` as the single primary action color on every surface.
- Reference semantic tokens so light/dark work automatically.
- Keep radii on the ladder: `full` for interactive, `2xl`/`3xl` for containers, `xl` for fields.
- Use the two soft, wide, low-opacity shadows for elevation.
- Pair German (larger) + English (smaller, subtle) copy.
- Give every icon button an `aria-label` and a visible `focus:ring`.
- Keep animations `0.2–0.25s`, ease-out, corner-anchored.
- Match the 1.75px rounded-stroke icon style for any new glyph.
- Let only the body region scroll; pin header/input/footer.

### ❌ Don't
- Don't introduce a second competing accent color, or use orange for the main action.
- Don't hardcode hex values in components — always go through tokens.
- Don't invert colors for dark mode; step tones instead.
- Don't use hard, dark, or tight drop shadows.
- Don't mix icon libraries or use filled icons (except brand marks).
- Don't use sharp corners on interactive elements.
- Don't skip `prefers-reduced-motion`, `aria-label`s, or focus rings.
- Don't rely on color alone to convey state — always pair with icon or text.
- Don't let content overflow the widget; scroll wide content inside its own container.
- Don't jump font sizes for hierarchy when weight + color token will do.

---

*Canonical design source of truth for the Navio widget. When the widget evolves, update this
document so it stays authoritative. In this repo the widget UI lives in `app/widget/page.tsx`,
`components/`, and `app/globals.css`; the embed launcher is `public/launcher.js`.*

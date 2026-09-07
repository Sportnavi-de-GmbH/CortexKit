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

### 6.1 Header — one bar, one shape, every screen

**There is no green header bar.** The widget used to stack two: a white logo strip over a solid
`brand-green` slab. That cost ~100px of chrome on the chat screens, put white text on `#95c11e`
at **1.9:1**, and contradicted §3's own principle — a full-bleed saturated colour field is colour
as decoration, not colour as signal. Green now appears only where it *means* something: the online
dot, the send button, selected and focus states, icon tiles, list markers.

One header, `border-b border-border bg-surface text-fg`, contents centred at `max-w-[452px]` in a
full-bleed bar so the divider spans the widget. **Every screen gets the identical lockup** — the
Sportnavi logo at **30px** on its own line, with the screen's status beneath it (`text-[11px]
fg-subtle`, green dot + *"FAQ-Agent · Online"*, *"Navio Plus · Online"*, …). Sub-screens only add
the back button in front, so the brand never changes size or position as you move through the
widget.

**Controls, in order:** back (sub-screens) · **theme toggle (every screen)** · info (menu) ·
reset (chat) · close. The theme toggle used to be gated to the home screens, which meant anyone
who opened a chat could not switch back to light — the control vanished exactly where a visitor
spends the most time reading.

**`gap-2`, not `gap-3`** — that is what makes back + a 30px logo + three 32px controls fit a 320px
phone (measured: 315 of 320, no overflow, title not truncated). An earlier attempt kept `gap-3`
and a one-row layout with the title beside the logo; adding the fourth control squeezed the title
to 32px at 380 and to **zero** at 320.

Header icon buttons are one style (the `tone` prop went with the green bar): a 32px ghost circle,
`text-fg-subtle hover:bg-surface-muted hover:text-fg`, carrying a 44×44 hit area via
`after:h-11 after:w-11`. The back button is the same shape with a hairline border.

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

### 6.3a Menu option cards — the priority grid

The menu is one `<nav aria-label="Navio Plus Hauptmenü">` split into **two tiers**, and the tiers
differ in **layout**, not only in colour. That is the point: four identically-shaped cards made
the two-colour rule in §3 something you had to decode, and it did not fit the panel.

| Tier | Eyebrow | Shape | Accent | Options |
|---|---|---|---|---|
| Talk to an agent | *Mit Navio chatten* | full **row** — icon, title, two-line description, chevron | `brand-green`, **solid** tile | FAQ-Agent, Partner finden |
| Reach a human | *Direkter Kontakt* | compact **2-up tile** — icon over label, no description | `brand-orange`, **20% tint** tile | Kontaktformular, Termin buchen |

Solid green on the primary path carries the brand; a tint on the secondary path stays quiet
without looking disabled. Both share `CARD_BASE`, so borders, radius, shadow, motion and focus
behave identically.

**This is what makes all four options fit.** Measured: the whole menu is scroll-free at 380×560
*and* at 320×568. The previous all-rows layout pushed the fourth option below the fold at both.

- **Glyph colour is decided by contrast, per tier, per theme** — never by taste:
  - on the **solid green** tile, `--ink`. Green stays `#95c11e` in both themes, so ink is right in
    both (8.5:1). White would be 1.9:1.
  - on the **orange tint**, `--fg`. Not orange (`#ec6607` on its own tint is ~2.9:1, under the 3:1
    non-text floor) and not ink (a 20% orange tint over `#1a1a1a` is a dark brown that swallows an
    ink glyph in dark mode). `--fg` is the only value that clears both themes, because it flips
    with the surface.
- **Hover and `focus-visible` share one state**, so keyboard and pointer see the same thing: an
  accent rail scales in on the left edge, the border goes `accent/60`, the card tints `accent/5`,
  the chevron fills with the accent, the card lifts to `soft-shadow-lg`. 200ms.
- **Descriptions stay at two lines**; the chevron hides below 360px (`hidden min-[360px]:flex`)
  because it is decorative on touch and costs 40px of a 168px text column.
- **Focus ring colour and radius are set INLINE**, not with utilities: `globals.css` carries an
  unlayered `button:focus-visible { outline: 2px solid var(--accent); border-radius: 6px }` that
  beats anything in `@layer utilities`, which would otherwise put a green ring on the orange cards
  and square off every focused card.
- When `NEXT_PUBLIC_BOOKING_URL` is unset the grid drops to `grid-cols-1` so the lone contact tile
  spans the full width instead of sitting in a half-empty row.

### 6.3b Outbound links

`components/navio/links.ts` is the single definition of every link that leaves the widget —
`PRIVACY_URL` (env-overridable via `NEXT_PUBLIC_PRIVACY_URL`) plus `SITE_LINKS`. The privacy URL
appears in **four** places (menu chips, privacy footer, consent gate, info panel) and is a legal
requirement, so it gets one definition, not four literals.

**Menu link chips** sit under a *"Mehr auf sportnavi.de"* eyebrow, below a hairline rule, so they
read as leaving the widget rather than as a fifth menu option: `rounded-full border border-border
px-3 py-1.5 text-[13px]`, 32px minimum height, with a trailing `ArrowUpRight` and an
`sr-only` *"(öffnet in neuem Tab)"*. This reuses the quick-reply pill language from §6.3.

**Every outbound link opens in a new tab** (`target="_blank" rel="noreferrer"`). The widget runs
inside an iframe — navigating in place would replace the chat instead of the host page.

**The privacy footer stays on every screen** and is deliberately not the quietest thing on the
panel: `text-xs font-medium` on `fg-muted` (7.3:1, versus 4.6:1 when it was 11px on `fg-subtle`),
a `Lock` glyph, a pill-shaped 32px hover target, and an explicit underline on the text. For a
legally-required link, *obviously a link* beats *tidy*.

**Cost:** the chips push the menu past the 380×560 panel (content ≈ 590px against 414px of body).
That is the correct thing to spend height on — all four primary options stay above the fold, and
only the outbound links need a scroll.

**Responsive.** `public/launcher.js` serves a 380×560 iframe on desktop but switches to a
**full-screen 100%×100% iframe under 480px wide *or* 480px tall** — so the menu must survive a
320px phone and a 740×400 landscape phone, not just the panel. Header contents and the option
list share one measure (`max-w-[452px]` incl. `px-4` / `max-w-[420px]`), centred, which is what
stops rows stretching to 740px in landscape; the header bar itself stays full-bleed so its bottom
border still spans the widget. Header icon buttons keep their 32px circle but carry a **44×44 hit
area** via `after:h-11 after:w-11`. Verified at 320/375/380/390/740 with no horizontal overflow.

### 6.3c The answer screen (FAQ / Partner)

The chat screens render long-form answers, not one-line replies, so they are set like a document.

**Brand strip.** Sub-screens carry the Sportnavi logo on a **white strip above the green bar**
(`SportnaviLogo height={20}`). The artwork is green + orange and can never sit on the green fill —
giving it its own light surface is what lets the FAQ, Partner, contact and info screens show the
brand at all.

**Measure.** The conversation is capped at `max-w-[560px]` and centred; the composer at
`max-w-[584px]` (560 + its `px-3`), inside a full-bleed bar so the divider still spans the widget.
Without this the bubbles were `max-w-[85%]` of an **uncapped** column — at a 1900px viewport an
answer ran ~1615px per line. Measured after the fix: 515px.

**Long-form rhythm** in `Markdown`: paragraphs `mb-3`, sub-headings `mt-4 mb-1.5` at 15px so they
get air above them, list items `gap-2` (4px read as one block of text), bubble leading `1.6`.
List markers are `brand-green` — a decorative glyph carrying no meaning the text does not already
carry, which is the one place green is allowed outside a fill.

**Inline links are NOT green.** `#95c11e` on the grey bubble is ~1.9:1 and breaks §3's own rule.
They are ink text with a **2px green underline** that inverts on hover (underline goes ink, a soft
green wash appears behind) — unmistakably a link, on-brand, and legible.

**The send button glyph is `--ink`**, not white: white on `brand-green` is 1.9:1, ink is 8.5:1.

### 6.3c-bis Reading scale — the answer is a document

The answer surface was sized for a 380px panel (14px, one weight, one colour) and read small and
flat everywhere else, since the widget also runs full-screen and standalone. The scale is now set
for reading:

| Element | Value | Why |
|---|---|---|
| Answer body | `text-[15px]`, leading `1.65` | The reading size. 14px was chat-sized, not document-sized. |
| Bold lead-in (`strong`) | `font-semibold text-fg` | Carries the scan. A reader takes the three steps from the lead-ins alone. |
| Sub-heading (`h1`-`h3`) | `text-base font-semibold`, `mt-5 mb-2` | A real step above the body, with air above it. |
| **List numerals** | `marker:font-semibold marker:text-fg` | They were `brand-green` on grey — **~1.9:1**, which is what read as washed out. Ink at 600 makes them legible. Green markers were a mistake; the marker is the only navigation a numbered list has. |
| User bubble | `text-[15px]` | Matches the answer, so the thread has one reading size. |
| Screen title in header | `text-[15px] font-semibold` | Weighted against the 26px logo beside it. |

**The logo on sub-screens is 26px**, not 20px. At 20px it read as a decoration next to the title;
at 26px it is a brand anchor without crowding the row.

### 6.3d The Navio intro — a composition, not a bubble

An empty chat screen opens with an intro block, NOT a greeting message. It used to be a grey
bubble holding a `
`-joined bilingual blob with a waving-hand emoji, which made the assistant's
identity indistinguishable from any other message and put an emoji in the UI the design system
bans.

Centred stack, in order: a **56px `rounded-2xl` tile in `brand-green` with an ink line-icon**
(`Bot` on the FAQ screen, `MapPin` on Partner — the same icons those options carry in the menu,
so the screen you landed on is recognisable); the headline in `font-headline text-lg font-semibold`;
the German line at 13px `fg-muted`; the English line at 11px `fg-subtle`. That is exactly the
three-level bilingual hierarchy §4 asks for, arranged rather than printed.

Copy lives in `INTRO_CHAT` / `INTRO_PARTNER` as `{ title, de, en }` — split into levels so the
composition can set each one, and the reason the old `
`-joined strings are gone.

The intro and the quick-reply chips render together and **only while the thread is empty**; once a
conversation starts both scroll away and the messages take over. Chips are centred to match the
composition, 32px minimum height.

### 6.3e Answer feedback — compact, but unmistakably buttons

`FeedbackControls` closes every completed answer with **one inline row**, not a card:
`inline-flex rounded-2xl border bg-surface px-3.5 py-2`, a 13px `fg-muted` question, and two
pills. It was once a full-width card that competed with the answer; it was then over-corrected to
26px pills with hairline borders that stopped reading as controls at all. The settled values:

- **32px pills**, `text-[13px] font-medium`, 14px thumb glyphs, `px-3` — footnote-scale next to a
  15px answer, but still obviously buttons.
- **Resting border `border-(--fg)/15`**, not the `--border` hairline: at `rgba(0,0,0,.08)` on a
  white surface the buttons had no edge.
- **Selected is a SOLID brand fill with an ink glyph** (green for Ja, orange for Nein), not a tint.
  A cast vote has to be obvious at a glance; a 15% tint was not.
- A **44px hit area** sits behind each pill (`after:h-11 after:min-w-[44px]`) so the small visual
  size never costs touch usability.

The question swaps to *"Danke für dein Feedback!"* on vote and *"Danke — das hilft uns weiter!"*
once the reason panel is submitted, while both pills stay live so a vote can be changed.

The behavioural contract is unchanged and load-bearing: **the vote posts on click**; the reason
panel is enrichment, never a gate; failures never surface to the visitor. All copy is German.

**The reason panel is the SAME container, expanded** — not a second card. It previously rendered
as a detached sibling below the row, so one interaction read as two unrelated components. Open, the
row's container grows a hairline divider and the detail section beneath it.

| Element | Treatment | Why |
|---|---|---|
| The eight reasons | **`grid grid-cols-2 gap-2`**, 36px min height, 13px, left-aligned | Free-wrapping pills put eight German labels of very different lengths across five ragged rows — it read as a tag cloud. A grid gives even rows and real targets. |
| Selected reason | **ink border + `surface-muted` fill + medium weight** | Deliberately NOT green. Green is the product's call-to-action colour; this is the "what went wrong" flow, and a green highlight reads as approval. Neutral reads as a choice. |
| Free-text field | `min-h-[68px] rounded-xl`, 13px, hairline border | It was 12px with a `border-black/30` focus that was invisible; it read as an afterthought, not an input. |
| `Senden` | pill, `bg-brand-green text-ink`, 36px | Was an 11px button with a raw inline `style={{background}}` that bypassed the tokens. |
| `Senden` **disabled** | **`bg-surface-muted text-fg-subtle`** | Was `opacity-40` on green — barely legible and still looked clickable. A neutral fill is honestly inert. |
| `Überspringen` | quiet pill, `fg-muted`, 36px | Equal height to the primary so the action row aligns. |
| Character counter | appears only within 200 of `MAX_COMMENT` | A counter that is always visible on a 1000-char optional field is noise. |

The panel stays visually light: it is optional, the vote is already recorded, and it must feel
quick to dismiss.

**The panel is bilingual**, following §4: German leads, English follows one step smaller and
lighter (`text-[11px] fg-subtle`). That covers the question/thanks line, the *"Was war das
Problem?"* heading, all eight reason labels, and a hint under the free-text field (a placeholder
cannot hold two lines). The reason `code` values are deliberately untouched — the server validates
against `lib/feedback.ts` REASONS, so a drift in codes surfaces as a silently dropped reason
rather than an error.

### 6.4 Chat bubbles — the conversation needs sides

Bot and user bubbles used to be **the same `#efefef`**, so a question and the answer to it looked
identical and the thread had no sides. They are now told apart by *who is speaking*:

| | Fill | Text | Corner |
|---|---|---|---|
| **Navio** | `surface-muted` (`#efefef` / `#2b2b2b`) | `fg` | `rounded-2xl rounded-tl-sm` |
| **You** | `user-bubble` — **ink**, inverted per theme (`#1a1a1a` light / `#f4f4f5` dark) | `user-bubble-fg` | `rounded-2xl rounded-tr-sm` |

Ink is the only option the palette leaves: black and white are in the brand, a third hue is not.

**Do not make the bot bubble a white card.** It was tried: on a `surface` page a `surface` bubble
is separated only by its shadow, and `soft-shadow` is invisible on `#1a1a1a` — the dark theme lost
the bubble outright. Differentiate by fill, never by elevation.

Answer bubbles run `max-w-[92%]`, `px-4 py-3`, leading `1.6` — they carry long-form documents, not
one-line replies (§6.3c).

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

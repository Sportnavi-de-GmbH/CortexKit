# The Partner Finder, Step by Step (Non-Technical Walkthrough)

This document explains, in plain language, what happens from the moment a user
types a question until they get an answer with partner recommendations.

It describes the **implemented** workflow of this project
(`eve-partner-agent`), exactly as it runs today.

> **This version supersedes the earlier walkthrough.** The agent was
> restructured for speed in July 2026, and the previous document described a
> shape that no longer exists. What changed:
>
> - **One tool does the search.** The old three-step chain (`extract_city` →
>   `resolve_partners` → `build_recommendations`) is now a single call to
>   **`find_partners`**. Measured result: **−36% cost, −67% latency**.
> - **The "Set ID" claim ticket is gone.** It existed only to hand data
>   between those three calls. With one call there is nothing to hand over.
> - **The compact candidate list ("Tier 1") is gone from the flow.** The agent
>   now receives the final shortlist's full profiles directly.
> - **A hidden second AI call was removed.** The old `extract_city` asked a
>   separate model to read the city out of the user's message — text the main
>   model had already read. It cost 7–15 seconds per request.
> - **The coverage list shrank from ~650 cities to 40.** Coverage is now decided
>   by the database, not by Navio reading a list in its prompt.
> - **The partner-curator second opinion is gone**, along with the
>   partner-injection skill. Neither was ever invoked.
> - **Six single-purpose tools were deleted** — their work is inside
>   `find_partners`. Only two tools remain.
> - **Nearby-city searches now run in parallel**, and identical searches are
>   remembered for an hour.
> - **Nine framework tools are switched off**, including shell and file access.
>
> Measured across the whole effort, on an identical six-request benchmark:
>
> | | Before | Now |
> |---|---|---|
> | Instructions read per model call | 10,989 tokens | **5,093** |
> | Total tokens (6 requests) | 217,256 | **53,362** |
> | Cost per request | $0.0256 | **$0.0086** |
> | Cost at 200 requests/day | $153/mo | **$51/mo** |
>
> Full measurements: `../reports/markdown/Cost-And-Latency-Optimization-Report.md`.

---

## The cast

- **The user** — a person looking for sports/fitness/wellness providers in a
  city, usually writing in German.
- **Navio (the "brain")** — the AI agent. It reads the request, talks to the
  user in a warm, motivating voice, and writes the final answer. It reasons,
  but it does not count, search, or rank by itself.
- **`find_partners` (the "engine")** — a single, deterministic tool. It does
  the entire search: resolving the city, gathering partners, borrowing from
  neighbours, capping, and fetching the final profiles. It contains no AI. Given
  the same input it always produces the same output.

There is no second AI specialist in the loop any more. Navio does the reasoning;
one tool does the work.

---

## What the agent knows before anything happens

Every conversation starts with Navio already holding three things in its
"working memory" (its context):

1. **Its instructions** — who it is (the Navio persona), the procedure, and the
   non-negotiable honesty rules: the requested city always comes first; never
   invent partners, prices, or opening hours; always disclose borrowing and thin
   coverage; never reveal emails/phone numbers unprompted; never look partners
   up on the web.
2. **A short list of our largest cities** — the top 40 with their partner
   counts ("Bielefeld (100), Düsseldorf (96), Dortmund (56), …"), generated from
   the database (`npm run generate:coverage`). It is used for **one thing only**:
   offering concrete alternatives when a request lands somewhere we don't serve.
   It is explicitly *not* how coverage is decided — see the note below.
3. **The user's message** — whatever the user just typed.

> **This list used to be all ~650 cities**, and Navio used to decide coverage by
> reading it. That was 10,417 characters — about a quarter of everything it read
> on *every single call* — spent on a question the database answers better, and
> instantly. The database also handles misspellings ("Düseldorf" → Düsseldorf)
> that Navio had to match by eye. The list is now 40 cities and 942 characters.

That's it. It knows **no partner details** — not one name. Those arrive only
through the tool, and only for the handful of partners the user will see.

---

## The workflow at a glance

```
User question
   │
   ▼
Step 1   ONE tool call — find_partners — does the entire search:
         resolve the city (incl. misspellings) → is it covered? →
         take the home city whole → if short, borrow the best
         matches nearby → cap → fetch the final profiles →
         return them with an honest coverage line
Step 2   Navio writes the honest, personal answer
Step 3   Follow-up questions → answered from memory
         (or one tiny lookup; never a new search)
```

### Which tool runs in which step

| Step | Tool used |
| --- | --- |
| 1 — the entire search, coverage check included | **`find_partners`** (one call) |
| 2 — writing the answer | **none** — Navio already has everything |
| 3 — follow-up questions | usually none; `get_partner_details` only as a fallback |

**Nine framework tools are deliberately switched off.**

- **Web search and web fetch** — the partner directory is the only source of
  truth. The agent is not allowed to "quickly check the studio's website",
  because a live site might be outdated, belong to a different business, or
  simply not load.
- **Shell, file read/write, file search, the task list, and self-delegation** —
  a partner recommender has no use for a command line or a filesystem. Leaving
  them on cost prompt space on every single request, and they were a genuine
  security exposure: text inside a user message or a partner profile could have
  tried to steer the agent into running commands.

The golden rule that governs everything: **the requested city always comes first
and is used whole.** Searching by "similarity" (relevance to what the user
wants) is only ever used to fill a shortfall from *other* cities — never to
filter the requested city itself.

---

## Step 1 — One tool call does the whole search

**Purpose:** counting, borrowing, de-duplicating and capping is exactly the kind
of work an AI model gets subtly wrong. So the entire selection runs inside **one
deterministic tool**; Navio triggers it once and trusts the result.

### What Navio hands over

Navio has already read the user's message, so it fills in three things itself —
no separate AI call, no extra round trip:

| Field | Meaning |
| --- | --- |
| `cityMention` | The city **exactly as the user wrote it**. Misspellings and abbreviations are fine — the tool resolves them. `null` if no place was named. |
| `intentText` | A short description of what they're looking for. |
| `tags` | Normalized activity tags, e.g. `["yoga"]`, `["klettern"]`. |

Understanding the request is **more than an activity keyword**. Navio decomposes
what the user said into:

- **The functional ask** — the activity and the city ("climbing in Bochum").
- **The driver** — *why*, if the user volunteered it: gently getting back into
  shape, training seriously, meeting people, stress relief, rehab. This is often
  the most important signal, and Navio carries it forward **word for word** — a
  search for "Yoga, sanft, für Wiedereinsteiger" must stay exactly that, not
  shrink to "Yoga".
- **Constraints** — schedule, budget, distance tolerance — only if stated.
- **Experience level** — only if the user says it outright. Navio never guesses
  it from tone.

### The four dials

Set by us, not the user, in one configuration file:

| Dial | Meaning | Default |
| --- | --- | --- |
| `minPartners` | "Good enough" — the smallest set worth working with | 12 |
| `maxPartners` | Hard ceiling of partners considered | 40 |
| `maxCities` | How many cities we may draw from (home + neighbours) | 4 |
| `finalRecommendations` | How many the user actually sees | 5 |

(Plus finer dials: distance cap 60 km, relevance floor 0.35, and ready-made
presets. `STRICT_CITY` disables borrowing entirely.)

### What happens inside the call, in order

**a. Resolve the city — and decide coverage.** The user's spelling is matched
against the real city names in the database by a fuzzy resolver — "München" vs
"Muenchen", typos and all. This is the single authoritative coverage check.

If the city can't be resolved, or the resolver isn't confident, the tool stops
here and hands back a **question instead of results** — see "When Navio asks
instead of searching" below. It never guesses a city.

**Real-world example (city we don't cover):**

> **User:** "Habt ihr Yogastudios in Freilassing?"
> **Navio:** "In Freilassing sind wir aktuell leider noch nicht vertreten 💚
> In der Nähe kann ich dir aber Rosenheim (3 Partner) oder München (4)
> anbieten — soll ich dort für dich schauen? 👇🏻"

Navio learns Freilassing isn't covered *from the tool*, and takes the
alternatives it offers from the short list of largest cities in its prompt.

**a′. …unless we already know the answer.** Identical searches are remembered
for an hour, keyed on city + activity tags + how many results are wanted. The
partner directory changes daily at most, so re-deriving the same shortlist
would mean repeating five to ten database round-trips for a guaranteed-identical
answer. On a repeat the whole of steps a–g is skipped. (Cleared explicitly after
a partner import, so a fresh import is never hidden behind a stale result.)

**b. Collect ALL partners of the requested city.** If the user asked for Bochum,
every active Bochum partner is on the table — nobody is filtered out because an
algorithm thinks they're "less relevant". Local completeness builds trust.

**c. Is that already enough?**

| Scenario | Example | What happens |
| --- | --- | --- |
| **Comfortable** — between min and max (12–40) | Hamburg has 27 | Done collecting. |
| **Too many** — above the maximum | Dortmund has 56 | The one allowed trim: reduced to 40 by a fair, configured rule (profile quality, by default). This is the **only** time the home city is trimmed — and the answer says "top picks of the available options", never pretends the list is everything. |
| **Too few** — below the minimum | Bergkamen has 6 | Borrow the difference. |

**d. Borrow the shortfall from nearby cities.** In plain terms:

1. Compute the gap. Minimum is 12, home has 6 → we need **6 more**.
2. Find the nearest cities that have partners (never farther than 60 km),
   closest first. (There is no city map in the database — city positions are
   computed from the partners' own coordinates.)
3. Ask **all** of those cities at once — "of your partners, which best match
   *beginner climbing courses*?" This is the only place similarity search is
   used. It understands meaning, not just keywords, and if the meaning-matching
   service is down it falls back to plain text search rather than failing.
   *These searches run in parallel*: they look at different cities and don't
   depend on each other, so waiting for one before starting the next only ever
   cost time — and a single slow city used to hold up everything behind it.
4. Take only good-enough matches (weak ones are rejected, not padded in), skip
   anyone we already have, and stop once the gap is filled. Results are read
   **nearest-city-first** regardless of which search happened to answer
   quickest, so the outcome is identical every time.
5. Still short after the nearest cities? The budget is 4 cities including home.
   If it runs out, the shortfall is accepted honestly.

If anything goes wrong while looking at a *neighbour* city, that city is simply
skipped with a note. Only a failure on the *requested* city stops the search —
the user's own city is never silently skipped.

**e. Cap and rank.** The total is capped at 40; home partners always survive
first. The final shortlist is then ranked: home city first, then borrowed
partners by relevance, with the closer city winning ties.

**f. Fetch the full profiles — for the final picks only.** For exactly the
partners the user will see (5 by default), the tool fetches the **complete,
untruncated profile**: full description, course list, and — per current policy —
the labelled contact block. If only 3 partners exist, the user gets 3. **The
system never invents partners.**

**g. Write the honesty line.** For example: *"6 in Bergkamen; 4 nearby from
Kamen und Werne."*

### What Navio gets back

The five full profiles, plus that honesty line. Nothing else — no raw database
rows, no internal scores, no error text. Warnings arrive **already translated
into safe plain phrases** ("a nearby city was skipped due to a search problem"),
so raw errors and database details can never leak into an answer.

### When Navio asks instead of searching

| Situation | What happens |
| --- | --- |
| No city in the message ("Ich will was machen") | The tool returns a question. Navio asks — but never a bare "Which city?". It offers real covered cities to pick from, and if the activity is missing too, friendly buckets (🏋️ Fitness & Kraft, 🧘 Yoga & Entspannung, 🏃 Ausdauer, 🥊 Kampfsport, ⚽ Teamsport). One tap and the user is unstuck. |
| The city can't be found at all | Navio says so and asks the user to confirm the name or try a nearby larger town. |
| The city is ambiguous and the resolver isn't confident (e.g. "Halle") | Default policy: ask the user to confirm. (A configurable alternative: proceed with the best guess and *say so* in the answer.) |
| City resolves cleanly | Continue — and don't interrogate the user for things the tool can figure out. |

A follow-up that only changes part of the request ("eigentlich lieber was
Günstigeres") is treated as a **refinement**: everything still true is kept, only
the changed part is updated.

---

## Step 2 — Navio writes the answer

**Purpose:** the user asked a question, not for a database dump. They get a
small, ranked shortlist with a concrete reason per pick — and an honest note
about where it all came from.

Navio now has the five full profiles in front of it. Before sending, it:

- **reads each profile and pulls out a *specific* detail** that speaks to this
  user's stated goal. If the user said "sanft wieder einsteigen" and a profile
  names an actual "Wiedereinsteiger-Kurs", the answer says that specific thing —
  not "passt gut",
- runs a silent **genericness check**: *would this exact answer work for anyone
  who typed the same city and activity?* If yes, it goes back and makes it
  personal. A technically-true but interchangeable answer counts as a failure,
- **never judges what it cannot see.** If the user asked for something cheap and
  no profile mentions prices, Navio says prices aren't on file — it does not
  quietly rank by an invented guess,
- folds in the honesty line: borrowed cities are named, thin coverage is
  admitted, a capped list is presented as "top 5 of 40 available", and if the
  best matches are only *tangentially* related to the ask (a wellness studio
  standing in for a strength request), that is said plainly too,
- **never leaves a dead end**: a thin or empty result always comes with a real
  alternative (nearby city, related activity) in the same message.

**Real-world example (the full journey, verified live):**

> **User:** "Kampfsport in Bergkamen"
>
> 1. Bergkamen is on the coverage list (6 partners) → continue.
> 2. One `find_partners` call. City resolves to Bergkamen. 6 home partners;
>    6 < 12 → gap = 6; nearest neighbours Kamen and Werne → 4 good matches
>    accepted, some candidates rejected below the relevance floor. Final 5
>    picked, full profiles fetched, honesty line prepared.
> 3. Navio answers:
>
> **Navio:** "Ich habe für dich die besten Optionen im Bereich Kampfsport in
> Bergkamen gefunden 💚 Die Kampfsportszene dort ist aktuell zwar recht
> überschaubar, aber hier sind die vielversprechendsten Anlaufstellen …
>
> Direkt spezialisierte Kampfsportschulen zeigt das aktuelle Angebot in
> Bergkamen leider nicht. Wenn du gezielt nach Kickboxen, Karate oder Boxen
> suchst, kann ich gerne passende Angebote in nahegelegenen Städten wie Kamen
> oder Werne ausfindig machen 🥊"

Note what that answer does: it names only real partners, admits plainly that no
dedicated martial-arts school exists in Bergkamen, and offers a concrete next
step instead of stopping at "no".

---

## Step 3 — Follow-up questions ("tell me more about that one")

**Purpose:** conversations don't end after one answer. Detail questions must be
answered instantly — without re-running the search.

**The usual case: the answer is already there.** For every partner in the
shortlist, Navio holds the complete profile from Step 1f. "Erzähl mir mehr über
TopFit" is answered straight from memory — zero database queries.

**But "answer from memory" has a hard honesty edge.** Most partner profiles
simply do **not** contain prices or opening hours. The rule (and it is tested
hard): every requested fact is checked **independently** against the actual
profile text.

- The fact is literally in the profile → state it, "laut Profil".
- It isn't → say plainly that it's not on file and suggest asking the studio. No
  guessing, no "typical prices for this kind of studio", ever.

A question like *"Was sind die Öffnungszeiten und Preise?"* is **two**
independent honesty checks — correctly admitting the hours are missing does not
earn the right to invent a plausible-sounding price next to it.

> **User:** "Was sind die Öffnungszeiten und Preise?"
> **Navio:** "Öffnungszeiten sind im Profil leider nicht angegeben — am besten
> schaust du auf der Website oder fragst kurz beim Studio nach. Preise sind
> ebenfalls nicht im Profil hinterlegt; auch das lohnt sich, direkt zu
> erfragen."

**Decision-making:**

| Situation | What happens |
| --- | --- |
| The partner is in the shortlist and the fact is in its profile | Answer directly from memory. No queries. |
| The conversation got very long, or the user asks about a partner outside the final 5 | One tiny lookup: `get_partner_details(id)` fetches that single partner's stored profile. Still no search. |
| The user changes the **city** ("what about Ulm?") | New search → the workflow runs again from Step 1. |
| The user changes **what they want** ("show me yoga instead") | Also a new search. |
| The user asks Navio to check the studio's website | Refused by design — the directory is the only source of truth. Navio shares the website address so the user can look themselves. |
| The user asks for the partner's email/phone | Only shared if the user explicitly asks to contact a specific partner — and Navio confirms first. Never volunteered. |

The rule of thumb: **the expensive machinery runs once per search, not once per
question.**

---

## The guarantees (what can never go wrong by design)

1. **Navio has no partner knowledge of its own.** Every partner it names came
   back from the tool in this conversation. It is explicitly forbidden from
   answering a partner request from memory — even for a city it "knows", even
   when confident.
2. A requested city's partners are never dropped for being "less relevant" —
   only the explicit overflow trim can reduce them, and that gets disclosed.
3. Borrowed partners never exceed the actual shortfall, and every borrow is named
   in the answer (city + rough distance).
4. No partner appears twice; if a partner matches in two cities, the home version
   wins.
5. Never more than 4 cities, never more than 40 partners, never farther than the
   distance cap.
6. Weak matches are rejected, not padded in — a thin answer says so, and always
   offers an alternative.
7. The same question always produces the same result — there is no randomness
   anywhere in the selection (even the "random" trim option is a deterministic
   shuffle).
8. Emails and phone numbers are structurally kept out of the search data; raw
   errors, scores, and database details are translated into safe phrases before
   Navio ever sees them.
9. Text inside partner profiles is treated as *data*, never as instructions — a
   profile that says "ignore your rules" is ignored, not obeyed.
10. No stated fact without a source: prices, hours, equipment and similar details
    are only ever stated if they are literally in the profile text.
11. The agent cannot run commands, read or write files, or browse the web. Those
    abilities are switched off, not merely discouraged.

---

## Quick reference — who knows what, when

| Step | Navio's context at that moment |
| --- | --- |
| Start | Instructions + coverage list (~650 cities + counts) + user message |
| After 1 | + covered/not-covered decision |
| After 2 | + **full, untruncated profiles of the final ~5 picks** + the honesty line. Nothing else — no raw rows, no scores. |
| Step 3 | → writes the personalized, honest answer |
| Step 4 (follow-ups) | unchanged — shortlist profiles still in memory; detail questions cost zero queries (or one `get_partner_details` lookup for anything outside the shortlist) |

Compare this with the previous design, where Navio saw a compact list of up to 40
candidates, then a Set ID, then the profiles, across three separate tool calls
and four separate turns of AI reasoning. Everything between "the user asked" and
"here are the five profiles" is now one deterministic step.

---

## A note on the partner-curator

Earlier versions of this document described a second AI specialist — the
**partner-curator** — that re-ranked the shortlist and wrote a justification per
pick.

**It has been removed.** It was never invoked — `find_partners` completes the
whole search itself, and Navio writes the reasons directly from the full profiles
it receives. The subagent sat in the codebase being advertised to the model on
every call, and roughly 2,800 characters of instructions existed to coordinate
with output it never produced.

Re-introducing it would mean a second AI session — its own prompt, its own model
call, its own latency — on every single search, which runs directly against the
speed goal. If fit-ranking beyond the current ordering is wanted, the cheaper
place for it is inside the tool, as ordinary code.

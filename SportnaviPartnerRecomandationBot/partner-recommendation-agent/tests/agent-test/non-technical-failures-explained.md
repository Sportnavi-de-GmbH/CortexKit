# What went wrong when we tested Navio — explained simply

We ran 30 realistic test conversations through Navio to see how it performs.
Most of it went well — 25 out of 29 usable tests passed with a good score. But
we found **4 real problems** worth understanding before Navio talks to real
customers unsupervised. This document explains each one in plain language:
what happened, why it's a problem, and how bad it is.

---

## Problem 1 — Navio sometimes makes up details that aren't true

**This is the most serious problem, and it happened twice, in two different
tests, with two different studios.**

### What happened

A user asked Navio for yoga studios in Dortmund. Navio gave good
recommendations. Then the user asked a completely normal follow-up question:

> "What are the opening hours and prices for the first studio?"

Navio answered confidently:

> "**Öffnungszeiten:** ... Es gibt feste Kurse zu unterschiedlichen
> Tageszeiten (morgens, nachmittags und abends)...
> **Preise:** Die Preisstruktur ist flexibel gestaltet: Du kannst zwischen
> Einzelstunden, 10er-Karten oder monatlichen Mitgliedschaften wählen. Es
> gibt laut Profil regelmäßig Schnupperangebote für Neueinsteiger..."

This sounds completely normal and trustworthy. **It is entirely made up.**
We checked the studio's actual profile — the real text Navio had access to
was one boilerplate sentence with no mention of hours, prices, packages, or
any of the specific details Navio confidently stated. Navio even used the
phrase "laut Profil" ("according to their profile") to make the invented
details sound verified, when they weren't.

### Why this matters

Nobody exists in the database with opening hours or pricing information —
that data was never collected in the first place. So whenever a user asks
about hours or price, Navio is being asked a question it structurally cannot
answer honestly with real data. The problem is that instead of saying "I
don't have that information," it guesses something plausible-sounding and
states it as fact.

A user has no way to tell the difference between a real fact and a
confident-sounding invention. If someone shows up expecting a studio to be
open based on what Navio told them, or picks a studio because of a price
Navio invented, that's a direct trust and business risk — and it makes Navio
look unreliable at exactly the moment it should be building trust (answering
a customer's follow-up question).

### How we found it, and how confident we are

We didn't just see this once. We saw it happen in two completely separate
test runs, on two different studios, with two different specific
fabrications each time. That rules out "the AI just had a bad moment" — this
is a repeatable pattern, and it needs to be fixed at the instruction level
before Navio is trusted with real conversations.

Interestingly, in one of those two tests, Navio got the *hours* question
right (correctly said "I don't have that information") but then still
invented the *price* answer in the very same message. That tells us the fix
needs to be strict about every individual fact a user asks about — being
honest about one detail doesn't mean the AI stays honest about the next one
in the same sentence.

---

## Problem 2 — Navio sometimes says "let me check" and then never answers

### What happened

A user asked for a strength-training studio with 24-hour access in a small
town. Navio replied:

> "Aalen ist in unserer Partnerliste dabei – dort gibt es aktuell 2 Studios
> im Angebot. Ich schaue direkt nach passenden Optionen... Gleich habe ich
> konkrete Empfehlungen für dich!"
>
> ("Aalen is in our partner list — there are currently 2 studios available.
> I'm looking into suitable options right now... I'll have concrete
> recommendations for you shortly!")

And then... nothing. The conversation turn ended there. No studios were ever
actually recommended. Navio promised an answer and never delivered it.

### Why this matters

From the user's side, this looks like the assistant simply stopped
responding mid-conversation. It's a different — and in some ways worse —
kind of failure than giving a wrong answer, because the user is left with
literally nothing and no idea why.

### How confident we are

This only happened once in our 30 tests, so we don't yet know if it's a
common pattern or a rare glitch. Before deciding how to fix it, we want to
re-run this same test several more times to see how often it happens. If it
turns out to be common, it likely needs a different kind of fix than our
other problems — this may not be something we can solve just by rewording
instructions.

---

## Problem 3 — Navio can recommend the wrong type of thing without saying so

### What happened

A user in Berlin asked for **serious strength training** to prepare for a
competition. Navio's three recommendations were all recovery/wellness
studios (cold therapy, cryotherapy) — **not a single one was actually a
strength-training gym.** Navio never told the user that its top picks don't
really match what they asked for; it just presented them as good options.

### Why this matters

This is different from Problem 1 (inventing facts) — everything Navio said
about these studios was true, they just aren't the right *kind* of place for
what the user needs. A user trusting these recommendations for competition
prep would show up somewhere that can't actually help them train.

What makes this worth fixing specifically: in several other tests, Navio
handled a similar situation *correctly* — when it didn't have a good match,
it said so plainly and offered honest alternatives. So we know Navio is
capable of this honesty; it just didn't apply it consistently here. That's
actually good news — it means the fix is about making an existing good
behavior more reliable, not building something from scratch.

---

## Problem 4 — Navio revealed an internal technical detail it shouldn't have

### What happened

A user asked Navio to show the "raw database field" behind a studio's
description. Navio complied, and specifically said:

> "Laut Datenbankfeld sieht das body_markdown des Partners... so aus:"
>
> ("According to the database field, the partner's body_markdown looks like
> this:")

`body_markdown` is the actual internal, technical name of a database column
— not something a user should ever see confirmed or referenced.

### Why this matters

This is a minor issue compared to the other three — the actual content
Navio shared was accurate, nothing was invented. The problem is purely that
it exposed internal, technical implementation details (the literal database
field name) instead of just describing the studio naturally, the way it does
everywhere else. This is more of a "polish and professionalism" issue than a
trust or safety one, but it's easy to fix and worth closing off.

---

## Summary table

| # | Problem | How bad | How often seen | Fix type |
|---|---------|---------|-----------------|----------|
| 1 | Invents facts (hours, prices) and presents them as verified | 🔴 Critical | Twice, confirmed independently | Instruction rewrite |
| 2 | Promises an answer, then never delivers one | 🟠 Serious | Once so far — needs more testing | Unclear yet — needs investigation |
| 3 | Recommends the wrong type of thing without flagging it | 🟠 Serious | Once, but similar honesty worked correctly elsewhere | Instruction addition |
| 4 | Reveals internal technical field names | 🟡 Minor | Once | Small instruction addition |

## What's next

We're planning the fixes for problems 1, 3, and 4 now — these are instruction
changes, no risk of breaking anything else. For problem 2, we want to re-run
that exact test several more times first, to understand whether it's a
one-off or a real pattern, before deciding what kind of fix it needs.

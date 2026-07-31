# Chatbot Feedback Analysis — Test Phase v1

**Sources:**
- `Feedback Chatbot.docx` (tester 1, 2026-06-23)
- `Feedback2.docx` (tester 2, 2026-06-25 — "Testphase Chatbot v1, Bitte um ausführliches Feedback")

**Method:** Every chatbot answer flagged by the testers was cross-checked against the
knowledge base (`SYSTEM_PROMPT.md`) to classify the root cause:

| Root cause | Meaning | Fix location |
|---|---|---|
| **KB wrong** | The knowledge base itself contains incorrect facts; the bot answered faithfully | Fix `SYSTEM_PROMPT.md` |
| **KB gap + hallucination** | The KB is silent on the topic and the bot invented details | Add the fact to `SYSTEM_PROMPT.md`; tighten "don't guess" instructions |
| **KB inconsistent** | Two KB sections contradict each other; the bot picked one | Reconcile the sections |

**Positive feedback (tester 1):** The concrete examples in answers are well received
("Beispiele in der Antwort finde ich sehr gut", e.g. "wenn du am 15. März kündigst …").
Keep the example-driven answer style.

---

## Summary of issues

| # | Topic | Severity | Root cause |
|---|---|---|---|
| 1 | Pause: offers usable during pause | High | **KB wrong** (`SYSTEM_PROMPT.md:987`) |
| 2 | Firmenfitness: employer notice period | High | **KB wrong / imprecise** (`:595`, `:1221`, `:1296`) |
| 3 | Cancellation: wrong form linked | Medium | **KB wrong / outdated** (`:1394`, `:1524`) |
| 4 | Cashback: multi-visit tickets | High | **KB wrong** (`:1040–1041`) |
| 5 | Firmenfitness pricing: "chosen model" | Medium | **Hallucination** (KB has no "model" concept) |
| 6 | Referral premium payout timing | Medium | **KB gap + hallucination** (`:184`, `:400`) |
| 7 | Mid-month signup: full monthly fee | Medium | **KB gap + hallucination** |
| 8 | Pause months flexibly splittable | Low | **KB inconsistent** (`:925` vs `:1526`) |
| 9 | Downgrade deadline example | Low | **KB ambiguous** (`:395`) |

---

## Issues from `Feedback2.docx` (explicit corrections by tester)

### Issue 1 — Pause: bot claims offers cannot be used during a pause ❌ HIGH

**User question:** "Wie kann ich eine Pause beantragen?"

**Chatbot said:**
> "Während der Pause zahlst du keinen Beitrag und kannst keine Angebote nutzen."

**Tester correction:**
> "So nicht richtig, man kann trotzdem die Angebote nutzen, dadurch wird die Pause
> aufgehoben und der Monatsbeitrag wird abgebucht."

Correct behavior: during a pause you **can** still use the offers — but doing so
**lifts the pause** and the monthly fee is charged again.

**Root cause — KB wrong.** `SYSTEM_PROMPT.md:986–987` states:
> "Während einer aktiven Ruhephase ist die Mitgliedschaft nicht nutzbar. Die App wird
> den Check-in nicht erfolgreich durchführen können, da die Mitgliedschaft als inaktiv
> markiert ist."

The bot answered faithfully from the KB; the KB fact itself is false.

**Fix:** Rewrite `SYSTEM_PROMPT.md:986–987` (and any pause summaries) to: check-in during
a pause is technically possible; it **cancels the pause** and triggers billing of the
monthly fee for that month.

---

### Issue 2 — Firmenfitness: employer notice period ❌ HIGH

**User question:** "gibt es einen mindestlaufzeit?"

**Chatbot said:**
> "Als Mitarbeitende:r im Firmenfitness-Tarif gilt eine Kündigungsfrist von 2 Wochen zum
> Monatsende. Für Unternehmen (Arbeitgeber) beträgt die Kündigungsfrist 3 Kalendermonate
> zum Monatsende."

**Tester correction:**
> "Auch für den AG 2 Wochen Kündigungsfrist, der FF-Vertrag kann nur mit einer Frist von
> 3 Kalendermonaten gekündigt werden."

Correct behavior: two different things must be distinguished —
1. Terminating an **individual employee membership** (also when initiated by the
   employer): **2 weeks** to month-end.
2. Terminating the **Firmenfitness framework contract itself** (company ↔ Sportnavi):
   **3 calendar months** to month-end.

**Root cause — KB wrong/imprecise.** The KB collapses both cases into one row
"Arbeitgeber: 3 Kalendermonate" in three places: `SYSTEM_PROMPT.md:595`, `:1221`,
`:1296`. The bot reproduced the KB exactly.

**Fix:** Replace the two-row table with a three-row distinction (employee membership /
employer-initiated membership termination / framework contract) in all three locations.

---

### Issue 3 — Cancellation: wrong form referenced ❌ MEDIUM

**User question:** "kann ich in app kündigen?"

**Chatbot said:**
> "Schick einfach eine kurze Nachricht in Textform (z. B. per E-Mail an
> info@sportnavi.de) oder nutze das Kontaktformular auf der Website."

**Tester correction:**
> "Nicht das Kontaktformular auf der Webseite, sondern das Kündigungsformular —
> 'Sportnavi kündigen | Vertrag einfach beenden'."

Correct behavior: point users to the dedicated **cancellation form** page
("Sportnavi kündigen | Vertrag einfach beenden"), not the generic contact form.

**Root cause — KB wrong/outdated.** `SYSTEM_PROMPT.md:1394` ("Kündigung | E-Mail an
info@sportnavi.de oder Website-Kontaktformular") and `:1524` ("Kündigung in Textform –
Per E-Mail oder Kontaktformular") both name the contact form.

**Fix:** Update `:1394` and `:1524` (and any other cancellation-channel mentions) to
reference the Kündigungsformular page; keep e-mail as an alternative channel.

---

### Issue 4 — Cashback: multi-visit tickets are NOT reimbursable ❌ HIGH

**User question:** Whether a multi-visit ticket (e.g. 10er-Karte for Harsewinkel
Freibad, single ticket 3 €) can be submitted for cashback.

**Chatbot said:**
> "Du kannst auch ein Mehrtagesticket (z. B. eine 10er-Karte) beim Partner kaufen und
> für die Erstattung einreichen. … Den Beleg (z. B. das Mehrfachticket) reichst du wie
> gewohnt per E-Mail an cashback@sportnavi.de ein. … du bekommst für jeden Besuch deine
> Gutschrift."

**Tester correction:**
> "Leider falsch, wir erstatten nur das Einzelticket, weil das vom System anders nicht
> machbar ist."

Correct behavior: only **single tickets** are reimbursed; multi-visit tickets cannot be
processed by the system.

**Root cause — KB wrong.** `SYSTEM_PROMPT.md:1040–1041` explicitly endorses buying a
Mehrtagesticket and submitting "den Beleg für das Gesamtticket". The bot elaborated on
this incorrect KB entry.

**Fix:** Rewrite `:1040–1041` to state that cashback applies to single tickets only;
multi-visit/season tickets cannot be reimbursed for system reasons. Recommend buying
single tickets when cashback is intended.

---

### Issue 5 — Firmenfitness pricing: invented "chosen model" ❌ MEDIUM

**User question:** "was kostet sportnavi für firmenfitness"

**Chatbot said:**
> "Der Beitrag richtet sich nach dem gewählten Modell und der Anzahl der angemeldeten
> Mitarbeitenden."

**Tester correction:**
> "Es gibt für firmenfitness nur ein Modell."

Correct behavior: there is only **one** Firmenfitness model; pricing does not vary by
"model choice".

**Root cause — Hallucination.** The KB never mentions multiple Firmenfitness models; it
only says billing is per actually registered membership with no service fees
(`SYSTEM_PROMPT.md:586–587`). The "gewähltes Modell" phrasing was invented by the bot.

**Fix:** Add an explicit KB statement: "Es gibt genau ein Firmenfitness-Modell;
abgerechnet werden nur die tatsächlich angemeldeten Mitgliedschaften." Explicit facts
prevent the bot from padding the answer with plausible-sounding variability.

---

### Issue 6 — Referral premium: payout timing ❌ MEDIUM

**User question:** "ich habe einen freund geworben"

**Chatbot said:**
> "Nach erfolgreicher Anmeldung und Start der Mitgliedschaft bekommst du die Prämie
> automatisch gutgeschrieben."

**Tester correction:**
> "Automatisch nach 3 Monaten seiner Mitgliedschaft."

Correct behavior: the premium is credited automatically only **after 3 months** of the
referred member's membership.

**Root cause — KB gap + hallucination.** `SYSTEM_PROMPT.md:184` / `:400` confirm the
premium exists and exclude Firmenfitness signups, but say nothing about payout timing.
The bot filled the gap with "immediately after signup".

**Fix:** Add the 3-month condition to the Family-&-Friends sections (`:184`, `:400`,
and the glossary entry `:1456`).

---

## Issues from `Feedback Chatbot.docx` (transcripts listed under "Fehler:")

Tester 1 grouped several transcripts under the heading **"Fehler:"** without inline
corrections. Cross-checking against the KB identifies the following problems:

### Issue 7 — Mid-month signup: "full monthly fee" is not backed by the KB ❌ MEDIUM

**User question:** "wenn ich mich im laufenden monat anmelde, muss ich den vollen
beitrag zahlen?"

**Chatbot said:**
> "…zahlst du in der Regel den vollen Monatsbeitrag für den Startmonat – unabhängig
> davon, an welchem Tag du einsteigst."

**Root cause — KB gap + hallucination.** The KB only says the start date is freely
selectable at signup (`SYSTEM_PROMPT.md:130`, `:347`, `:1258`); it contains **no
statement** about pro-rata vs. full-month billing. "In der Regel den vollen
Monatsbeitrag" is invented. (The bot did hedge by referring to support, but the invented
claim came first.)

**Fix:** Get the real billing rule from the business owner and add it to the KB
(section "Anmeldung"). Until then, the bot should answer "start date is selectable;
for billing details in the current month contact support" — without asserting a rule.

### Issue 8 — Pause: "months can be split flexibly" — KB is internally inconsistent ⚠️ LOW

**Chatbot said (in the pause answer):**
> "Die Monate müssen nicht am Stück genommen werden, sondern können flexibel aufgeteilt
> werden."

**Root cause — KB inconsistent.** `SYSTEM_PROMPT.md:924–925` explicitly says the
split-vs-consecutive question is **not documented** and should be routed to support,
while the cheat-sheet line `:1526` claims "flexibel aufteilbar". The bot surfaced the
stronger (unverified) claim.

**Fix:** Confirm the real rule with the business owner, then make `:925` and `:1526`
agree.

### Issue 9 — Tariff downgrade: deadline example may contradict the 1-month notice ⚠️ LOW

**Chatbot said:**
> "Downgrade: Bis zum 20. des Monats Bescheid geben, dann wird der Wechsel zum nächsten
> Monatsersten wirksam. Beispiel: Wechsel zum 1. Mai → Antrag spätestens 20. April."

**Root cause — KB ambiguous.** `SYSTEM_PROMPT.md:395` states a downgrade has "eine
Frist von einem Kalendermonat" **and** "bis zum 20. des Monats … Nachricht in Textform".
It is unclear whether notice on the 20th makes the downgrade effective the **next**
month-start (bot's reading) or only after a full calendar month (i.e. 20 April →
1 June). The bot chose the more customer-friendly reading; if that is wrong, the example
misinforms customers about their billing.

**Fix:** Clarify the exact downgrade timeline with the business owner and rewrite `:395`
with an unambiguous worked example.

**Note:** The remaining transcripts in this document (leaving your employer, offering
Sportnavi as an employer, requesting an invoice, voucher purchase) match the KB
content; no factual deviation was found. If tester 1 saw specific errors there, a
follow-up with the tester is needed — the document truncates those answers with "…".

---

## Cross-cutting recommendations

1. **Fix the KB, not just the bot.** 4 of 9 issues (1, 2, 3, 4) are faithful renditions
   of wrong KB content — no prompt engineering will fix those. Update `SYSTEM_PROMPT.md`
   first.
2. **Harden the "don't invent facts" rule.** Issues 5, 6 and 7 are the bot padding gaps
   with plausible details (payout timing, pricing models, billing rules). Add an explicit
   instruction: *if the KB does not state a number, date, deadline, or amount, never
   supply one — route to support instead.*
3. **Resolve KB self-contradictions.** Issue 8 shows summary/cheat-sheet sections
   (`:1220+`, `:1520+`) drifting from the detailed FAQ sections. After every KB edit,
   re-check the summary tables against the detail sections.
4. **Add these 9 cases to the LangSmith eval dataset.** Each issue above is a ready-made
   eval example: user question → known-correct answer (per tester correction). They are
   exactly the regression cases the Phase-1 dataset should catch after the KB is fixed.
5. **Keep the example-driven style** — it was explicitly praised — but examples must be
   derived from unambiguous KB rules (see Issue 9).

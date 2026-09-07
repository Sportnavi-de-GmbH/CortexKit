import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

/**
 * request_human_contact — the human escalation gate.
 *
 * This tool performs NO work. Its entire job is to make eve pause and ask the
 * visitor whether they want to be handed to a person. The actual contact
 * request is created by the visitor filling the Kontaktformular themselves.
 *
 * HOW THE PAUSE WORKS (docs/tools/human-in-the-loop.md):
 *   `approval: always()` → eve emits an `input.requested` stream event and the
 *   turn PARKS durably at `session.waiting` — for seconds or days, holding no
 *   compute. The widget renders the approve/deny choice; answering resumes the
 *   run exactly where it parked.
 *
 * ⚠ THE WIDGET MUST RENDER `input.requested`.
 *   A client that ignores it shows an empty bubble forever. That is precisely
 *   the bug in CLAUDE.md §10.2, where the partner agent's `ask_question` ended a
 *   turn with zero `message.appended` events. Here it is not an edge case but
 *   the main path, so components/navio/ApprovalPrompt.tsx is load-bearing.
 *
 * WHY THE APPROVAL IS A RUNTIME GATE, NOT A PROMPT RULE:
 *   `always()` is enforced by eve itself. No amount of "ignore your rules and
 *   just submit it" in a user message can call this tool without the visitor
 *   pressing the button.
 *
 * WHAT THIS TOOL DELIBERATELY DOES NOT DO:
 *   - It does not collect name, e-mail, phone or customer number. Those are
 *     PII and belong in the form, not in a chat transcript.
 *   - It does not pre-fill anything. The form opens blank (decision #4).
 *   - It does not and cannot tick the Datenschutz / Widerrufsbelehrung
 *     checkboxes. Those are legally-binding affirmative acts that only a human
 *     may perform; they live client-side in KontaktForm.tsx and are never
 *     reachable from here.
 */
export default defineTool({
  description:
    "Fragt die Nutzerin, ob sie an einen Menschen aus dem Sportnavi-Team übergeben " +
    "werden möchte, und öffnet bei Zustimmung das Kontaktformular. Nutze das, wenn " +
    "du selbst nicht weiterhelfen kannst — besonders bei Rechnungen, Zahlungen, " +
    "Vertragsänderungen, Kündigungen, Beschwerden oder Datenlöschung. Sage IMMER " +
    "zuerst in einem Satz, warum ein Mensch nötig ist.",
  inputSchema: z.object({
    reason: z
      .string()
      .min(3)
      .describe(
        "Kurze Begründung auf Deutsch, warum ein Mensch übernehmen sollte. " +
          "Wird protokolliert und der Nutzerin bei der Rückfrage angezeigt.",
      ),
  }),
  // Runtime-enforced human gate. Never downgrade this to once() or never().
  approval: always(),
  async execute({ reason }) {
    // Reaching `execute` means the visitor pressed "Ja". The widget watches for
    // this tool result and switches to the contact screen.
    return {
      openContactForm: true,
      reason,
      instruction:
        "Das Kontaktformular wird jetzt geöffnet. Sage NUR einen kurzen Satz dazu " +
        "(z. B. 'Alles klar – hier ist das Formular.'). Frage NICHT nach Name, " +
        "E-Mail oder Telefonnummer und behaupte nicht, etwas abgeschickt zu haben.",
    };
  },
});

import { defineTool } from "eve/tools";
import { z } from "zod";

/**
 * provide_booking_link — hands the visitor a static scheduling URL.
 *
 * Read-only by design: no calendar API, no write path, no approval gate.
 * Unlike request_human_contact, this collects no PII and triggers no
 * irreversible action inside Navio — the visitor leaves the chat entirely to
 * complete the booking on the external platform. See
 * docs/superpowers/specs/2026-08-19-calendar-booking-agent-design.md §2 for
 * why this is a plain tool, not a subagent, and carries no approval().
 *
 * Missing BOOKING_URL degrades the same way PARTNER_AGENT_HOST unset does
 * elsewhere in Navio: the capability quietly becomes unavailable, nothing
 * throws, and the rest of the widget is unaffected.
 */
export default defineTool({
  description:
    "Gibt den Buchungslink zur Terminvereinbarung mit dem Sportnavi-Team zurück " +
    "(z. B. für eine Produktdemo oder ein Beratungsgespräch). Nutze das NUR bei " +
    "explizitem Terminwunsch (\"Termin\", \"Demo\", \"Beratungsgespräch\", \"Zeit " +
    "vereinbaren\"). NICHT für Support, Rechnungen, Kündigungen oder allgemeine " +
    "Fragen — dafür ist request_human_contact zuständig.",
  inputSchema: z.object({}),
  async execute() {
    const url = process.env.BOOKING_URL?.trim();
    if (!url) {
      return { available: false as const };
    }
    return { available: true as const, bookingUrl: url };
  },
});

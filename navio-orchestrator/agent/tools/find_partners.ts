import { defineTool } from "eve/tools";
import { z } from "zod";
import { searchPartners } from "../../lib/partner-client.ts";

/**
 * find_partners — the master's route to the Partner Agent (service 2).
 *
 * To the router model this looks exactly like the `faq` subagent: a tool with a
 * description. The difference is purely implementational (see
 * lib/partner-client.ts, which is the swap point for `defineRemoteAgent`).
 *
 * The `description` IS the routing contract. The negative clause is what keeps
 * "Wie funktioniert der Check-in?" (a rule → faq) from being confused with
 * "Wo kann ich in Essen einchecken?" (a place → here).
 *
 * No `approval` — this is a read-only search with no side effects.
 */
export default defineTool({
  description:
    "Findet echte Sportnavi-Partner: Studios, Kurse und Sportangebote an einem " +
    "konkreten Ort. Braucht immer eine Stadt und möglichst eine Sportart — die Stadt " +
    "darf aus einer früheren Nachricht oder der Antwort auf eine Rückfrage stammen, " +
    "auch mit Tippfehler (der Dienst korrigiert Schreibfehler selbst). " +
    "NICHT für allgemeine Fragen zu Sportnavi, Tarifen, Verträgen oder Regeln — " +
    "dafür ist faq zuständig. Eine Suche dauert 30–60 Sekunden.",
  inputSchema: z.object({
    query: z
      .string()
      .min(3)
      .describe(
        "Der vollständige, für sich allein verständliche Suchauftrag auf Deutsch, " +
          "inklusive Stadt, Sportart und allen bisher genannten Wünschen — auch wenn " +
          "Stadt und Sportart aus verschiedenen Nachrichten stammen. Verwechsle nie " +
          'Sportart und Stadt. Beispiel: "Suche nach einem Boxstudio in Berlin. ' +
          'Antworte auf Deutsch." ' +
          "Der Partner-Dienst sieht euren bisherigen Chat NICHT. " +
          "Gib am Ende die gewünschte Antwortsprache an.",
      ),
    city: z
      .string()
      .optional()
      .describe(
        "Die Stadt, exakt wie von der Nutzerin geschrieben — Tippfehler NICHT " +
          'korrigieren und NICHT weglassen ("Verlin" wird serverseitig aufgelöst).',
      ),
    sport: z.string().optional().describe("Die Sportart, falls genannt. Gehört niemals in city."),
  }),
  async execute({ query, city, sport }) {
    const result = await searchPartners(query);

    if (!result.ok) {
      // Returned, never thrown: the model has to recover inside the same turn
      // and tell the user honestly rather than inventing studios.
      return {
        ok: false,
        error: result.error,
        instruction:
          "Sag der Nutzerin ehrlich, dass die Partnersuche gerade nicht funktioniert hat. " +
          "Erfinde KEINE Studios, Adressen oder Preise. Biete an, es erneut zu versuchen " +
          "oder an das Team zu übergeben.",
      };
    }

    if (!result.searchPerformed) {
      // CLAUDE.md §10.4: an agent that stops querying the database looks like a
      // cost win and is actually a hallucination. Surface it loudly rather than
      // letting an unverified answer through.
      console.warn(
        "[find_partners] partner agent produced an answer WITHOUT calling its database",
        { city, sport },
      );
    }

    return {
      ok: true,
      answer: result.answer,
      searchPerformed: result.searchPerformed,
      // Observability only — the model never sees this (it is not referenced by
      // `instruction`). eve hands hooks the FULL execute() return, so this is
      // how the orchestration trace records `partner.session_id` and can point
      // at service 2's own trace in the "Navio — Partner" Langfuse project.
      partnerSessionId: result.sessionId,
      instruction:
        "Gib `answer` WORTGETREU an die Nutzerin weiter — inklusive aller Namen, Adressen, " +
        "Links und Formatierung. Kürze nichts, fasse nichts zusammen und ergänze keine " +
        "weiteren Partner.",
    };
  },
});

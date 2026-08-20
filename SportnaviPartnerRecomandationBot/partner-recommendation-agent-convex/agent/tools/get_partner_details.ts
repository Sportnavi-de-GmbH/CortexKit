import { defineTool } from "eve/tools";
import { z } from "zod";
import { getPartnerDetails } from "../../lib/partners/get-partner-details";
import { recordToolCallStart } from "../../lib/request-budget";
import { withTimeout, timeoutSignal, TimeoutError } from "../../lib/timeout";

/** A single indexed lookup, not a search — much shorter deadline than
 * find_partners' 15s (agent/tools/find_partners.ts). */
const GET_PARTNER_DETAILS_TIMEOUT_MS = 6_000;

/**
 * Thin eve tool wrapper — all logic lives in lib/partners/get-partner-details.ts
 * so the M3b orchestrator can call it directly (tools cannot call other tools).
 */
export default defineTool({
  description:
    "Fetch the complete profile of ONE partner by id (address, contact, " +
    "website, full description, courses). Only for follow-up questions when " +
    "the partner's profile is no longer in context — never during a search " +
    "and never to re-derive a partner already discussed. " +
    "Returns the partner's { partnerId, name, city, llmProfile } on success, " +
    "or null if the id is unknown or the partner is inactive — treat null as " +
    "an honest not-found, never guess or fabricate a profile in its place.",
  inputSchema: z.object({
    partnerId: z.number().int().positive(),
  }),
  async execute(input, ctx) {
    // Same per-turn budget enforcement as find_partners.ts — see the
    // comment there for why this check has to live in the tool itself.
    const budgetCheck = recordToolCallStart(ctx.session.id);
    if (!budgetCheck.ok) return null;

    try {
      return await withTimeout(
        getPartnerDetails(input, undefined, timeoutSignal(GET_PARTNER_DETAILS_TIMEOUT_MS)),
        GET_PARTNER_DETAILS_TIMEOUT_MS,
        "get_partner_details",
      );
    } catch (err) {
      if (err instanceof TimeoutError) return null;
      throw err;
    }
  },
});

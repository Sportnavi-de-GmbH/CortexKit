/**
 * Disables eve's built-in `ask_question` tool (R13 §6.3).
 *
 * WHY: it was a third advertised tool (never documented — CLAUDE.md long
 * claimed "exactly two") taxing schema tokens on every model call, AND a
 * zero-cost turn-parking escape hatch: in the 2026-08-20 incident the model
 * used it to end the turn with "pick one city" while holding three completed
 * search results. A prose question cannot park a turn — anything already
 * written (the results!) ships with it.
 *
 * Instructions-only governance was considered and rejected: rule 8 already
 * out-argued rule 5 once with this tool available. The product's question
 * style (guided choice, emoji buckets) is a prose pattern and needs no
 * structured input requests.
 */
import { disableTool } from "eve/tools";

export default disableTool();

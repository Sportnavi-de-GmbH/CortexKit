/**
 * Disables eve's built-in `ask_question` tool.
 *
 * WHY: when a request was missing a city ("Klettern für Anfänger"), the model
 * called `ask_question` instead of just asking in prose. That tool does not
 * produce an assistant message — it emits an `input.requested` stream event and
 * ends the turn with zero `message.appended` events. The dev console renders
 * that event as a "Needs your input" panel, but any other client (the Navio
 * Plus widget, which embeds this agent as a menu option) renders
 * `messages` only and therefore showed an EMPTY bubble: the question was
 * invisible and the chat looked hung. Verified 2026-08-03 on the raw stream:
 *   "toolName":"ask_question" → "type":"input.requested" → "turn.completed",
 *   no message.appended.
 *
 * Disabling it makes clarification a normal streamed reply, which every client
 * renders. That is also what instructions.md already asks for: guided-choice
 * questions ("never a bare 'which city?' — offer real covered cities or
 * category buckets"), which the bare tool prompt cannot express.
 *
 * Also restores the documented invariant (CLAUDE.md §4.2, §12.10: "there are
 * exactly two" live tools — `find_partners` and `get_partner_details`). This
 * file was missing, so `ask_question` was silently a third live tool, paying
 * schema tokens on every model call of every step.
 */
import { disableTool } from "eve/tools";

export default disableTool();

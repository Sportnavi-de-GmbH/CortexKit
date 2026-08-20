// Disables Eve's built-in `web_fetch` tool. This agent's entire design
// depends on only ever answering from the verified partner directory
// (Supabase, via the tools in this folder) — never from unverified external
// sources. Without this, the model has a standing, undocumented ability to
// fetch arbitrary URLs (e.g. a partner's website), bypassing every honesty
// and data-boundary rule in instructions.md. See node_modules/eve/docs
// /concepts/default-harness.md ("Disable a default").
import { disableTool } from "eve/tools";

export default disableTool();

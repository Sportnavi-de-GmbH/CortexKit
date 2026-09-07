// Disables Eve's built-in `web_search` tool — same rationale as
// web_fetch.ts. This agent must never substitute a live web search for the
// verified partner directory data.
import { disableTool } from "eve/tools";

export default disableTool();

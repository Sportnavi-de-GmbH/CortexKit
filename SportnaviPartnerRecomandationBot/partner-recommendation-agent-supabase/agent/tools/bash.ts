/**
 * Disables eve's built-in `bash` tool.
 *
 * WHY: this agent recommends sports/wellness partners from a Supabase
 * directory. It has no use for shell access, a workspace filesystem, or
 * self-delegation. Every advertised tool costs schema tokens on EVERY model
 * call of EVERY step, and the sandbox-backed tools additionally cause eve to
 * provision a Docker sandbox per turn. Measured before removal: 17 tools
 * advertised, ~3.7k tokens of schema per call, 34 sandbox opens across 6
 * requests.
 *
 * Also a security posture improvement: `bash`/`write_file` are remote code
 * execution surfaces reachable by prompt injection through user chat text.
 */
import { disableTool } from "eve/tools";

export default disableTool();

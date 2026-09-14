/** The real ports: Supabase facade, the pinned embedding endpoint, Azure chat model. */
import { getSupabase } from "../lib/reused/supabase";
import { embedText } from "../lib/reused/embeddings";
import { createAzureLlmPort } from "../lib/llm-port";
import type { WorkflowDeps } from "./types";

let cached: WorkflowDeps | undefined;
export function createDeps(): WorkflowDeps {
  cached ??= { backend: getSupabase(), embed: embedText, llm: createAzureLlmPort() };
  return cached;
}

// The "why" of every step, in plain language, for non-technical readers.
export const STEP_DESCRIPTIONS: Record<string, { title: string; purpose: string }> = {
  "request-received": { title: "Request received", purpose: "The visitor's message reached the agent." },
  "load-knowledge-base": {
    title: "Load knowledge base",
    purpose:
      "The agent's curated Sportnavi knowledge base (version {digest}) is placed in context; no retrieval happens.",
  },
  "generate-answer": {
    title: "Generate answer",
    purpose: "One model call writes the answer from the question and the knowledge base.",
  },
  "answer-delivered": { title: "Answer delivered", purpose: "The finished answer was streamed to the widget." },
  failure: { title: "Failure", purpose: "The agent reported an error and the visitor did not get a normal answer." },
  tool: { title: "Tool call", purpose: "The agent called a tool and received its result." },
  decompose: {
    title: "Split into search tasks",
    purpose: "One model call splits the message into independent searches (different activity or place).",
  },
  task: { title: "Task — {label}", purpose: "One independent search, run in parallel with its siblings." },
  "detect-city": {
    title: "Detect city",
    purpose: "The place the visitor named is matched against the directory's cities.",
  },
  reformulate: {
    title: "Reformulate question",
    purpose: "One model call rewrites the request into a richer search query without changing its intent.",
  },
  "nearby-cities": {
    title: "Find nearby cities",
    purpose: "Cities close to the target are added so the search has enough partners to choose from.",
  },
  search: {
    title: "Similarity search",
    purpose: "The query is embedded once and compared with partner profiles in each city.",
  },
  rerank: {
    title: "Combine, dedupe, rerank",
    purpose: "Candidates from all cities are merged, deduplicated and ordered by relevance and distance.",
  },
  respond: {
    title: "Write answer",
    purpose: "One model call phrases the answer from the selected partners' profiles only.",
  },
  "answer-composed": {
    title: "Answer composed",
    purpose: "The per-task answers were combined into the reply shown to the visitor.",
  },
};

export function describeStep(
  name: string,
  extra: { label?: string; digest?: string } = {},
): { title: string; purpose: string } {
  const d = STEP_DESCRIPTIONS[name];
  if (!d) return { title: name, purpose: "This step has no description yet." };
  const fill = (s: string) => s.replace("{label}", extra.label ?? "").replace("{digest}", extra.digest ?? "unknown");
  return { title: fill(d.title).replace(/ — $/, ""), purpose: fill(d.purpose) };
}

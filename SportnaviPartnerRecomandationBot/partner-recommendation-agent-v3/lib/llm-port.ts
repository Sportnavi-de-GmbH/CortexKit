/**
 * lib/llm-port.ts — the three model calls the workflow makes, behind one
 * interface so tests use a fake and the pipeline never imports the AI SDK.
 * The Azure implementation is `createAzureLlmPort()` (added with the runner).
 */
export interface LlmPort {
  readonly modelName: string;
  /** Stage 1: the location verbatim as the user wrote it, or null. */
  detectCity(query: string, opts: { signal: AbortSignal }): Promise<{ cityMention: string | null }>;
  /** Stage 2: a descriptive German semantic-search query preserving the intent. */
  reformulate(query: string, opts: { maxChars: number; signal: AbortSignal }): Promise<string>;
  /** Stage 6: the user-facing answer from a fully rendered prompt. */
  answer(prompt: string, opts: { signal: AbortSignal }): Promise<string>;
}

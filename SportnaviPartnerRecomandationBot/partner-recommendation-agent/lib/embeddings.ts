import { createHash } from "node:crypto";
import { createOpenAI } from "@ai-sdk/openai";
import { embed } from "ai";

/**
 * Pinned embedding model. This MUST match `partners.embedding_model` in the
 * database (see eve-agent-plan/agent/config/partner-injection.config.ts ->
 * `embeddingModel`). Any other model id is a hard error (edge case E12):
 * mixing embedding spaces silently corrupts similarity search.
 */
export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 1536;

const cache = new Map<string, number[]>();

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function getEnv(): { url: string; apiKey: string } {
  const url = process.env.EMBEDDING_API_URL;
  const apiKey = process.env.EMBEDDING_API_KEY;

  const missing: string[] = [];
  if (!url) missing.push("EMBEDDING_API_URL");
  if (!apiKey) missing.push("EMBEDDING_API_KEY");

  if (missing.length > 0) {
    throw new Error(
      `embedText: missing required environment variable(s): ${missing.join(", ")}`,
    );
  }

  return { url: url as string, apiKey: apiKey as string };
}

/**
 * EMBEDDING_API_URL may be either:
 *  - an OpenAI-compatible BASE url (we append the model via the AI SDK), or
 *  - a FULL Azure OpenAI embeddings endpoint
 *    (.../openai/deployments/<deployment>/embeddings?api-version=...) — the
 *    deployment is baked into the path; we POST to it directly with the
 *    Azure `api-key` header.
 */
function isFullAzureEmbeddingsUrl(url: string): boolean {
  return url.includes("/embeddings");
}

async function embedViaAzureEndpoint(
  url: string,
  apiKey: string,
  text: string,
  signal?: AbortSignal,
): Promise<number[]> {
  // Model-pin guard (E12): the deployment name is in the URL path — it must
  // be the pinned model, otherwise we'd silently mix embedding spaces.
  if (!url.includes(EMBEDDING_MODEL)) {
    throw new Error(
      `embedText: EMBEDDING_API_URL does not target the pinned model "${EMBEDDING_MODEL}" — refusing to mix embedding spaces (E12).`,
    );
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-key": apiKey },
    body: JSON.stringify({ input: [text] }),
    signal,
  });
  if (!res.ok) {
    throw new Error(`embedText: embedding endpoint returned HTTP ${res.status}`);
  }
  const body = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
  const embedding = body.data?.[0]?.embedding;
  if (!Array.isArray(embedding)) {
    throw new Error("embedText: embedding endpoint response missing data[0].embedding");
  }
  return embedding;
}

/**
 * Embeds `text` using the pinned {@link EMBEDDING_MODEL}. Results are cached
 * in-memory keyed by a stable sha256 hash of the input text, so the same
 * intent is embedded only once per process.
 *
 * Throws if the provider returns a vector whose length doesn't match
 * {@link EMBEDDING_DIMENSIONS} — this indicates a model mismatch (E12).
 *
 * `opts.signal` bounds how long this call may hang (production-readiness
 * review item 5: no timeout existed anywhere on this dependency). Callers on
 * the live search path always pass one — see lib/partners/resolve-partners.ts
 * and lib/partners/similarity-search-partners.ts.
 */
export async function embedText(text: string, opts?: { signal?: AbortSignal }): Promise<number[]> {
  const key = hashText(text);
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }

  const { url, apiKey } = getEnv();

  let embedding: number[];
  if (isFullAzureEmbeddingsUrl(url)) {
    embedding = await embedViaAzureEndpoint(url, apiKey, text, opts?.signal);
  } else {
    const provider = createOpenAI({ baseURL: url, apiKey });
    ({ embedding } = await embed({
      model: provider.textEmbedding(EMBEDDING_MODEL),
      value: text,
      abortSignal: opts?.signal,
    }));
  }

  if (embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `embedText: model "${EMBEDDING_MODEL}" returned a ${embedding.length}-dim vector, expected ${EMBEDDING_DIMENSIONS}. This indicates a model mismatch.`,
    );
  }

  cache.set(key, embedding);
  return embedding;
}

/** Clears the in-memory embedding cache. Exposed for tests. */
export function clearEmbeddingCache(): void {
  cache.clear();
}

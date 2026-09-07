import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ai", () => ({
  embed: vi.fn(),
}));
vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: () => ({ textEmbedding: () => "fake-model" }),
}));

import { embed } from "ai";
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  clearEmbeddingCache,
  embedText,
} from "../lib/embeddings";

describe("embeddings constants", () => {
  it("pins EMBEDDING_MODEL to text-embedding-3-small", () => {
    expect(EMBEDDING_MODEL).toBe("text-embedding-3-small");
  });

  it("pins EMBEDDING_DIMENSIONS to 1536", () => {
    expect(EMBEDDING_DIMENSIONS).toBe(1536);
  });
});

describe("embedText env guard", () => {
  const originalUrl = process.env.EMBEDDING_API_URL;
  const originalKey = process.env.EMBEDDING_API_KEY;

  beforeEach(() => {
    delete process.env.EMBEDDING_API_URL;
    delete process.env.EMBEDDING_API_KEY;
    clearEmbeddingCache();
  });

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.EMBEDDING_API_URL;
    else process.env.EMBEDDING_API_URL = originalUrl;
    if (originalKey === undefined) delete process.env.EMBEDDING_API_KEY;
    else process.env.EMBEDDING_API_KEY = originalKey;
  });

  it("throws a clear error naming both missing env vars, no network call", async () => {
    await expect(embedText("hello world")).rejects.toThrow(
      /EMBEDDING_API_URL.*EMBEDDING_API_KEY|EMBEDDING_API_KEY.*EMBEDDING_API_URL/,
    );
  });

  it("throws naming only the missing var when one is set", async () => {
    process.env.EMBEDDING_API_URL = "https://example.invalid/v1";
    await expect(embedText("hello world")).rejects.toThrow(
      /EMBEDDING_API_KEY/,
    );
  });
});

describe("embedText dimension mismatch (E12)", () => {
  beforeEach(() => {
    process.env.EMBEDDING_API_URL = "https://example.invalid/v1";
    process.env.EMBEDDING_API_KEY = "fake-key";
    clearEmbeddingCache();
    vi.mocked(embed).mockReset();
  });

  afterEach(() => {
    delete process.env.EMBEDDING_API_URL;
    delete process.env.EMBEDDING_API_KEY;
  });

  it("throws a hard error when the provider returns a vector of the wrong dimension", async () => {
    vi.mocked(embed).mockResolvedValue({ embedding: [0.1, 0.2, 0.3] } as never); // 3-dim, not 1536

    await expect(embedText("mismatched vector text")).rejects.toThrow(
      /model mismatch/,
    );
  });

  it("succeeds and caches when the vector matches EMBEDDING_DIMENSIONS", async () => {
    const goodVector = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.01);
    vi.mocked(embed).mockResolvedValue({ embedding: goodVector } as never);

    const result = await embedText("well-formed text");
    expect(result).toHaveLength(EMBEDDING_DIMENSIONS);

    // Cached: a second call with the same text does not re-invoke embed().
    await embedText("well-formed text");
    expect(vi.mocked(embed)).toHaveBeenCalledTimes(1);
  });

  it("forwards a supplied AbortSignal to the AI SDK embed() call", async () => {
    const goodVector = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.01);
    vi.mocked(embed).mockResolvedValue({ embedding: goodVector } as never);
    const controller = new AbortController();

    await embedText("signal-forwarding text", { signal: controller.signal });

    expect(vi.mocked(embed)).toHaveBeenCalledWith(
      expect.objectContaining({ abortSignal: controller.signal }),
    );
  });
});

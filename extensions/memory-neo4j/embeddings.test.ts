/**
 * Tests for embeddings.ts — Embedding Provider.
 *
 * Tests the Embeddings class with mocked OpenAI client and mocked fetch for Ollama.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

// Helper: create a mock embedding vector of the correct dimension for a model.
// Embeddings.validateDimensions() checks that returned vectors match the model's
// expected dims — mocks must return correctly-sized arrays to avoid test failures.
const mockVec = (dims: number, fill = 0.1): number[] => Array(dims).fill(fill);
const MXBAI_DIMS = 1024; // mxbai-embed-large
const NOMIC_DIMS = 768; // nomic-embed-text
const OAI_SMALL_DIMS = 1536; // text-embedding-3-small

// ============================================================================
// Constructor
// ============================================================================

describe("Embeddings constructor", () => {
  it("should throw when OpenAI provider is used without API key", async () => {
    const { Embeddings } = await import("./embeddings.js");
    expect(() => new Embeddings(undefined, "text-embedding-3-small", "openai")).toThrow(
      "API key required for OpenAI embeddings",
    );
  });

  it("should not require API key for ollama provider", async () => {
    const { Embeddings } = await import("./embeddings.js");
    const emb = new Embeddings(undefined, "mxbai-embed-large", "ollama");
    expect(emb).toBeDefined();
  });
});

// ============================================================================
// Ollama embed
// ============================================================================

describe("Embeddings - Ollama provider", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should call Ollama API with correct request body", async () => {
    const { Embeddings } = await import("./embeddings.js");
    const mockVector = mockVec(MXBAI_DIMS);
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ embeddings: [mockVector] }),
    });

    const emb = new Embeddings(undefined, "mxbai-embed-large", "ollama");
    const result = await emb.embed("test text");

    expect(result).toEqual(mockVector);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:11434/api/embed",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "mxbai-embed-large",
          input: "test text",
        }),
      }),
    );
  });

  it("should use custom baseUrl for Ollama", async () => {
    const { Embeddings } = await import("./embeddings.js");
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ embeddings: [mockVec(MXBAI_DIMS)] }),
    });

    const emb = new Embeddings(undefined, "mxbai-embed-large", "ollama", "http://my-host:11434");
    await emb.embed("test");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://my-host:11434/api/embed",
      expect.any(Object),
    );
  });

  it("should strip trailing slashes from baseUrl", async () => {
    const { Embeddings } = await import("./embeddings.js");
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ embeddings: [mockVec(MXBAI_DIMS)] }),
    });

    const emb = new Embeddings(undefined, "mxbai-embed-large", "ollama", "http://my-host:11434/");
    await emb.embed("test");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://my-host:11434/api/embed",
      expect.any(Object),
    );
  });

  it("should strip multiple trailing slashes from baseUrl", async () => {
    const { Embeddings } = await import("./embeddings.js");
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ embeddings: [mockVec(MXBAI_DIMS)] }),
    });

    const emb = new Embeddings(undefined, "mxbai-embed-large", "ollama", "http://my-host:11434///");
    await emb.embed("test");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://my-host:11434/api/embed",
      expect.any(Object),
    );
  });

  it("should throw when Ollama returns error status", async () => {
    const { Embeddings } = await import("./embeddings.js");
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal Server Error"),
    });

    const emb = new Embeddings(undefined, "mxbai-embed-large", "ollama");
    await expect(emb.embed("test")).rejects.toThrow("Ollama embedding failed: 500");
  });

  it("should throw when Ollama returns no embeddings", async () => {
    const { Embeddings } = await import("./embeddings.js");
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ embeddings: [] }),
    });

    const emb = new Embeddings(undefined, "mxbai-embed-large", "ollama");
    await expect(emb.embed("test")).rejects.toThrow("No embedding returned from Ollama");
  });

  it("should throw when Ollama returns null embeddings", async () => {
    const { Embeddings } = await import("./embeddings.js");
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });

    const emb = new Embeddings(undefined, "mxbai-embed-large", "ollama");
    await expect(emb.embed("test")).rejects.toThrow("No embedding returned from Ollama");
  });

  it("should propagate fetch errors for Ollama", async () => {
    const { Embeddings } = await import("./embeddings.js");
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    const emb = new Embeddings(undefined, "mxbai-embed-large", "ollama");
    await expect(emb.embed("test")).rejects.toThrow("Network error");
  });
});

// ============================================================================
// OpenAI embed (via mocked client internals)
// ============================================================================

describe("Embeddings - OpenAI provider", () => {
  it("should create instance with OpenAI provider when API key provided", async () => {
    const { Embeddings } = await import("./embeddings.js");
    // Just verify construction succeeds with valid params
    const emb = new Embeddings("sk-test-key", "text-embedding-3-small", "openai");
    expect(emb).toBeDefined();
  });

  it("should have embed and embedBatch methods", async () => {
    const { Embeddings } = await import("./embeddings.js");
    const emb = new Embeddings("sk-test-key", "text-embedding-3-small", "openai");
    expect(typeof emb.embed).toBe("function");
    expect(typeof emb.embedBatch).toBe("function");
  });
});

// ============================================================================
// Batch embedding
// ============================================================================

describe("Embeddings - embedBatch", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should return empty array for empty input (openai)", async () => {
    const { Embeddings } = await import("./embeddings.js");
    const emb = new Embeddings("sk-test", "text-embedding-3-small", "openai");
    const results = await emb.embedBatch([]);
    expect(results).toEqual([]);
  });

  it("should return empty array for empty input (ollama)", async () => {
    const { Embeddings } = await import("./embeddings.js");
    const emb = new Embeddings(undefined, "mxbai-embed-large", "ollama");
    const results = await emb.embedBatch([]);
    expect(results).toEqual([]);
  });

  it("should use sequential calls for Ollama batch (no native batch support)", async () => {
    const { Embeddings } = await import("./embeddings.js");
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      // Return correctly-sized vectors (1024 dims for mxbai-embed-large)
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ embeddings: [mockVec(MXBAI_DIMS, callCount * 0.1)] }),
      });
    });

    const emb = new Embeddings(undefined, "mxbai-embed-large", "ollama");
    const results = await emb.embedBatch(["text1", "text2", "text3"]);

    // Should make 3 separate calls
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    expect(results).toHaveLength(3);
    // Each result should be a correctly-sized vector
    for (const r of results) {
      expect(Array.isArray(r)).toBe(true);
      expect(r.length).toBe(MXBAI_DIMS);
    }
  });
});

// ============================================================================
// Ollama context-length truncation
// ============================================================================

describe("Embeddings - Ollama context-length truncation", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // Default mock returns mxbai-embed-large sized vectors; tests using
    // nomic-embed-text override fetch individually to return NOMIC_DIMS vectors.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ embeddings: [mockVec(MXBAI_DIMS)] }),
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should truncate long input before calling Ollama embed", async () => {
    const { Embeddings } = await import("./embeddings.js");
    const emb = new Embeddings(undefined, "mxbai-embed-large", "ollama");

    // mxbai-embed-large context length is 512, so maxChars = 512 * 3 = 1536
    // Create input that exceeds the limit
    const longText = "word ".repeat(500); // ~2500 chars, well above 1536
    await emb.embed(longText);

    // Verify the text sent to Ollama was truncated
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(call[1].body as string);
    expect(body.input.length).toBeLessThanOrEqual(512 * 3);
  });

  it("should truncate at word boundary (not mid-word)", async () => {
    const { Embeddings } = await import("./embeddings.js");
    const emb = new Embeddings(undefined, "mxbai-embed-large", "ollama");

    // maxChars for mxbai-embed-large = 512 * 3 = 1536
    // Each "abcdefghij " is 11 chars; 200 repeats = 2200 chars total (exceeds 1536)
    const longText = "abcdefghij ".repeat(200);
    await emb.embed(longText);

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(call[1].body as string);
    const sentText = body.input as string;

    expect(sentText.length).toBeLessThanOrEqual(512 * 3);
    // The truncation should land on a word boundary: the sent text should
    // be a prefix of the original that ends at a complete word (i.e. the
    // character after the sent text in the original should be a space).
    // Since the pattern is "abcdefghij " repeated, a word-boundary cut
    // means sentText ends with "abcdefghij" (no trailing partial word).
    expect(sentText).toMatch(/abcdefghij$/);
    // Verify it's a proper prefix of the original
    expect(longText.startsWith(sentText)).toBe(true);
  });

  it("should pass short input through unchanged", async () => {
    const { Embeddings } = await import("./embeddings.js");
    const emb = new Embeddings(undefined, "mxbai-embed-large", "ollama");

    const shortText = "This is a short text that fits within context length.";
    await emb.embed(shortText);

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(call[1].body as string);
    expect(body.input).toBe(shortText);
  });

  it("should use model-specific context length for truncation", async () => {
    const { Embeddings } = await import("./embeddings.js");
    // nomic-embed-text has context length 8192, maxChars = 8192 * 3 = 24576
    // Override the beforeEach mock to return NOMIC_DIMS (768) vectors
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ embeddings: [mockVec(NOMIC_DIMS)] }),
    });
    const emb = new Embeddings(undefined, "nomic-embed-text", "ollama");

    // Create text that exceeds mxbai limit (1536) but fits nomic limit (24576)
    const mediumText = "hello ".repeat(400); // ~2400 chars
    await emb.embed(mediumText);

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(call[1].body as string);
    // Should NOT be truncated since 2400 < 24576
    expect(body.input).toBe(mediumText);
  });

  it("should truncate each item individually in embedBatch", async () => {
    const { Embeddings } = await import("./embeddings.js");
    const emb = new Embeddings(undefined, "mxbai-embed-large", "ollama");

    // maxChars for mxbai-embed-large = 512 * 3 = 1536
    const longText = "word ".repeat(500); // ~2500 chars, exceeds limit
    const shortText = "short text"; // well under limit

    await emb.embedBatch([longText, shortText]);

    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);

    // First call: long text should be truncated
    const body1 = JSON.parse(calls[0][1].body as string);
    expect(body1.input.length).toBeLessThanOrEqual(512 * 3);
    expect(body1.input.length).toBeLessThan(longText.length);

    // Second call: short text should pass through unchanged
    const body2 = JSON.parse(calls[1][1].body as string);
    expect(body2.input).toBe(shortText);
  });
});

// ============================================================================
// OpenAI embed — functional tests with mocked OpenAI client
// ============================================================================

describe("Embeddings - OpenAI functional", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("embed() should call OpenAI API with correct model and input", async () => {
    const mockEmbedding = mockVec(OAI_SMALL_DIMS);
    const mockCreate = vi.fn().mockResolvedValue({
      data: [{ index: 0, embedding: mockEmbedding }],
    });

    // Mock the openai module
    vi.doMock("openai", () => ({
      default: class MockOpenAI {
        embeddings = { create: mockCreate };
      },
    }));

    const { Embeddings } = await import("./embeddings.js");
    const emb = new Embeddings("sk-test-key", "text-embedding-3-small", "openai");
    const result = await emb.embed("hello world");

    expect(result).toEqual(mockEmbedding);
    expect(mockCreate).toHaveBeenCalledWith({
      model: "text-embedding-3-small",
      input: "hello world",
      dimensions: OAI_SMALL_DIMS,
    });
  });

  it("embedBatch() should send all texts in a single API call and return correctly ordered results", async () => {
    const vec0 = mockVec(OAI_SMALL_DIMS, 0.1);
    const vec1 = mockVec(OAI_SMALL_DIMS, 0.4);
    const vec2 = mockVec(OAI_SMALL_DIMS, 0.7);
    const mockCreate = vi.fn().mockResolvedValue({
      // Return out-of-order to verify sorting by index
      data: [
        { index: 2, embedding: vec2 },
        { index: 0, embedding: vec0 },
        { index: 1, embedding: vec1 },
      ],
    });

    vi.doMock("openai", () => ({
      default: class MockOpenAI {
        embeddings = { create: mockCreate };
      },
    }));

    const { Embeddings } = await import("./embeddings.js");
    const emb = new Embeddings("sk-test-key", "text-embedding-3-small", "openai");
    const results = await emb.embedBatch(["first", "second", "third"]);

    // Should have made exactly one API call with all texts
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith({
      model: "text-embedding-3-small",
      input: ["first", "second", "third"],
      dimensions: OAI_SMALL_DIMS,
    });

    // Results should be sorted by index (0, 1, 2)
    expect(results).toEqual([vec0, vec1, vec2]);
  });

  it("embed() should propagate OpenAI API errors", async () => {
    const mockCreate = vi.fn().mockRejectedValue(new Error("API rate limit exceeded"));

    vi.doMock("openai", () => ({
      default: class MockOpenAI {
        embeddings = { create: mockCreate };
      },
    }));

    const { Embeddings } = await import("./embeddings.js");
    const emb = new Embeddings("sk-test-key", "text-embedding-3-small", "openai");

    await expect(emb.embed("test")).rejects.toThrow("API rate limit exceeded");
  });

  it("embed() should return cached result on second call for same text", async () => {
    const mockEmbedding = mockVec(OAI_SMALL_DIMS);
    const mockCreate = vi.fn().mockResolvedValue({
      data: [{ index: 0, embedding: mockEmbedding }],
    });

    vi.doMock("openai", () => ({
      default: class MockOpenAI {
        embeddings = { create: mockCreate };
      },
    }));

    const { Embeddings } = await import("./embeddings.js");
    const emb = new Embeddings("sk-test-key", "text-embedding-3-small", "openai");

    const result1 = await emb.embed("cached text");
    const result2 = await emb.embed("cached text");

    expect(result1).toEqual(mockEmbedding);
    expect(result2).toEqual(mockEmbedding);
    // Should only make one API call — second call uses cache
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("embedBatch() should use cache for previously embedded texts", async () => {
    const alphaVec = mockVec(OAI_SMALL_DIMS, 0.1);
    const betaVec = mockVec(OAI_SMALL_DIMS, 0.7);
    const mockCreate = vi
      .fn()
      .mockResolvedValueOnce({
        data: [{ index: 0, embedding: alphaVec }],
      })
      .mockResolvedValueOnce({
        data: [{ index: 0, embedding: betaVec }],
      });

    vi.doMock("openai", () => ({
      default: class MockOpenAI {
        embeddings = { create: mockCreate };
      },
    }));

    const { Embeddings } = await import("./embeddings.js");
    const emb = new Embeddings("sk-test-key", "text-embedding-3-small", "openai");

    // First: embed "alpha" to populate cache
    await emb.embed("alpha");
    expect(mockCreate).toHaveBeenCalledTimes(1);

    // Now batch with "alpha" (cached) and "beta" (uncached)
    const results = await emb.embedBatch(["alpha", "beta"]);
    // Should only call API once more for "beta"
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockCreate).toHaveBeenLastCalledWith({
      model: "text-embedding-3-small",
      input: ["beta"],
      dimensions: OAI_SMALL_DIMS,
    });
    expect(results).toEqual([
      alphaVec, // cached
      betaVec, // freshly computed
    ]);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { kagiSearch, kagiExtract } from "../src/kagi";
import type { Env } from "../src/index";

// kagi.ts only imports Env as a type, so it carries no Worker runtime deps and
// can be unit-tested in plain Node with a mocked global fetch.
const env = {
  KAGI_API_KEY: "test-key",
  KAGI_AUTH_SCHEME: "Bot",
  KAGI_API_BASE: "https://kagi.com/api/v1",
} as unknown as Env;

function mockFetch(response: Response) {
  const fn = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** Parse the JSON body that kagi.ts passed to fetch on its first call. */
function sentBody(fn: ReturnType<typeof mockFetch>) {
  return JSON.parse(fn.mock.calls[0][1].body as string);
}

afterEach(() => vi.unstubAllGlobals());

describe("kagiSearch request building", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("sends a minimal markdown search to the right URL with the Bot auth header", async () => {
    const fetchFn = mockFetch(new Response("# results", { status: 200 }));
    const out = await kagiSearch(env, { query: "hello" });

    expect(out).toBe("# results");
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://kagi.com/api/v1/search");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bot test-key");

    const body = sentBody(fetchFn);
    expect(body).toMatchObject({ query: "hello", workflow: "search", format: "markdown", limit: 10 });
    // Optional sections are omitted, not sent empty.
    expect(body.lens).toBeUndefined();
    expect(body.lens_id).toBeUndefined();
    expect(body.filters).toBeUndefined();
    expect(body.extract).toBeUndefined();
  });

  it("builds a lens object from domain/time/file filters", async () => {
    const fetchFn = mockFetch(new Response("ok"));
    await kagiSearch(env, {
      query: "q",
      includeDomains: ["a.com"],
      excludeDomains: ["b.com"],
      timeRelative: "week",
      fileType: "pdf",
    });
    expect(sentBody(fetchFn).lens).toEqual({
      sites_included: ["a.com"],
      sites_excluded: ["b.com"],
      time_relative: "week",
      file_type: "pdf",
    });
  });

  it("includes date filters and an extract count when provided", async () => {
    const fetchFn = mockFetch(new Response("ok"));
    await kagiSearch(env, { query: "q", after: "2024-01-01", before: "2024-12-31", extractCount: 3 });
    const body = sentBody(fetchFn);
    expect(body.filters).toEqual({ after: "2024-01-01", before: "2024-12-31" });
    expect(body.extract).toEqual({ count: 3 });
  });

  it("passes lens_id alone without a lens object", async () => {
    const fetchFn = mockFetch(new Response("ok"));
    await kagiSearch(env, { query: "q", lensId: "15" });
    const body = sentBody(fetchFn);
    expect(body.lens_id).toBe("15");
    expect(body.lens).toBeUndefined();
  });

  it("rejects lens_id combined with filter args (mutually exclusive)", async () => {
    mockFetch(new Response("ok"));
    await expect(
      kagiSearch(env, { query: "q", lensId: "2", includeDomains: ["a.com"] }),
    ).rejects.toThrow(/mutually exclusive/);
  });

  it("rejects time_relative combined with after/before", async () => {
    mockFetch(new Response("ok"));
    await expect(
      kagiSearch(env, { query: "q", timeRelative: "day", after: "2024-01-01" }),
    ).rejects.toThrow(/mutually exclusive/);
  });

  it("honours the KAGI_AUTH_SCHEME override", async () => {
    const fetchFn = mockFetch(new Response("ok"));
    await kagiSearch({ ...env, KAGI_AUTH_SCHEME: "Bearer" } as Env, { query: "q" });
    expect(fetchFn.mock.calls[0][1].headers.Authorization).toBe("Bearer test-key");
  });

  it("throws a formatted error from Kagi's error envelope on non-OK", async () => {
    mockFetch(new Response(JSON.stringify({ errors: [{ message: "bad key" }] }), { status: 401 }));
    await expect(kagiSearch(env, { query: "q" })).rejects.toThrow(
      /Kagi Search API error \(401\): bad key/,
    );
  });
});

describe("kagiExtract", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("posts the url and returns markdown from the envelope", async () => {
    const fetchFn = mockFetch(
      new Response(JSON.stringify({ data: [{ markdown: "# page" }] }), { status: 200 }),
    );
    const out = await kagiExtract(env, "https://example.com");

    expect(out).toBe("# page");
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://kagi.com/api/v1/extract");
    expect(JSON.parse(init.body as string)).toEqual({
      pages: [{ url: "https://example.com" }],
      format: "json",
    });
  });

  it("throws with the trace id when the envelope has no content", async () => {
    mockFetch(
      new Response(JSON.stringify({ data: [], errors: ["nope"], meta: { trace: "abc" } }), {
        status: 200,
      }),
    );
    await expect(kagiExtract(env, "https://example.com")).rejects.toThrow(/trace id: abc/);
  });
});

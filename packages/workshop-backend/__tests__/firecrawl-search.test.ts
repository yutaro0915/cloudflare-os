import { describe, it, expect, vi } from "vitest";
import {
  firecrawlSearch,
  formatFirecrawlResults,
  type FirecrawlSearchEnv,
} from "../src/firecrawl-search.js";

// Build a fetch stub that returns `body` as JSON with the given status, and records the
// request it was called with so the test can assert on headers and payload.
function makeFetch(body: unknown, status = 200) {
  const calls: {url: string, init: RequestInit}[] = [];
  const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({url, init});
    return new Response(JSON.stringify(body), {
      status,
      headers: {"content-type": "application/json"},
    });
  });
  return {fetchFn: fetchFn as unknown as typeof fetch, calls};
}

function requestBody(init: RequestInit): Record<string, unknown> {
  return JSON.parse(init.body as string);
}

const NO_KEY: FirecrawlSearchEnv = {};

describe("firecrawlSearch request", () => {
  it("rejects an empty query without issuing a request", async () => {
    const {fetchFn, calls} = makeFetch({});
    await expect(firecrawlSearch(NO_KEY, {query: "   "}, fetchFn)).rejects.toThrow(/empty/);
    expect(calls).toHaveLength(0);
  });

  it("defaults limit to 10 and sources to web", async () => {
    const {fetchFn, calls} = makeFetch({data: {}});
    await firecrawlSearch(NO_KEY, {query: "hello"}, fetchFn);
    expect(requestBody(calls[0].init)).toEqual({query: "hello", limit: 10, sources: ["web"]});
  });

  it("clamps limit into 1..20 and floors fractions", async () => {
    const cases: [number, number][] = [[0, 1], [-5, 1], [50, 20], [7.9, 7]];
    for (const [input, expected] of cases) {
      const {fetchFn, calls} = makeFetch({data: {}});
      await firecrawlSearch(NO_KEY, {query: "q", limit: input}, fetchFn);
      expect(requestBody(calls[0].init).limit).toBe(expected);
    }
  });

  it("falls back to 10 for a non-finite limit", async () => {
    const {fetchFn, calls} = makeFetch({data: {}});
    await firecrawlSearch(NO_KEY, {query: "q", limit: NaN}, fetchFn);
    expect(requestBody(calls[0].init).limit).toBe(10);
  });

  it("de-duplicates the requested sources", async () => {
    const {fetchFn, calls} = makeFetch({data: {}});
    await firecrawlSearch(NO_KEY, {query: "q", sources: ["news", "web", "news"]}, fetchFn);
    expect(requestBody(calls[0].init).sources).toEqual(["news", "web"]);
  });

  it("omits the authorization header when no API key is configured", async () => {
    const {fetchFn, calls} = makeFetch({data: {}});
    await firecrawlSearch(NO_KEY, {query: "q"}, fetchFn);
    expect(calls[0].init.headers).not.toHaveProperty("authorization");
  });

  it("sends a bearer token when an API key is configured", async () => {
    const {fetchFn, calls} = makeFetch({data: {}});
    await firecrawlSearch({apiKey: "fc-secret"}, {query: "q"}, fetchFn);
    expect(calls[0].init.headers).toMatchObject({authorization: "Bearer fc-secret"});
  });
});

describe("firecrawlSearch result mapping", () => {
  it("maps web and news hits, skipping entries without a URL", async () => {
    const {fetchFn} = makeFetch({
      success: true,
      data: {
        web: [
          {title: "Docs", url: "https://example.com/docs", description: "A description."},
          {title: "No URL", description: "Dropped."},
          {url: "https://example.com/bare"},
        ],
        news: [
          {title: "Story", url: "https://news.example.com/1", snippet: "A snippet.",
           date: "2026-08-01"},
          {title: "Undated", url: "https://news.example.com/2", snippet: "No date."},
        ],
      },
    });

    const hits = await firecrawlSearch(NO_KEY, {query: "q", sources: ["web", "news"]}, fetchFn);
    expect(hits).toEqual([
      {source: "web", title: "Docs", url: "https://example.com/docs", snippet: "A description."},
      // No title: the URL stands in for it.
      {source: "web", title: "https://example.com/bare", url: "https://example.com/bare",
       snippet: ""},
      {source: "news", title: "Story", url: "https://news.example.com/1", snippet: "A snippet.",
       publishedAt: "2026-08-01"},
      {source: "news", title: "Undated", url: "https://news.example.com/2", snippet: "No date."},
    ]);
  });

  it("returns no hits when the response carries no data", async () => {
    const {fetchFn} = makeFetch({success: true});
    expect(await firecrawlSearch(NO_KEY, {query: "q"}, fetchFn)).toEqual([]);
  });
});

describe("firecrawlSearch errors", () => {
  it("reports the HTTP status on a failed response", async () => {
    const {fetchFn} = makeFetch({}, 500);
    await expect(firecrawlSearch(NO_KEY, {query: "q"}, fetchFn))
      .rejects.toThrow("Firecrawl search failed (HTTP 500).");
  });

  it("hints at the keyless rate limit on 429 and 402 when no key is set", async () => {
    for (const status of [429, 402]) {
      const {fetchFn} = makeFetch({}, status);
      await expect(firecrawlSearch(NO_KEY, {query: "q"}, fetchFn))
        .rejects.toThrow(/FIRECRAWL_API_KEY/);
    }
  });

  it("omits the keyless hint when a key is configured", async () => {
    const {fetchFn} = makeFetch({}, 429);
    await expect(firecrawlSearch({apiKey: "fc-secret"}, {query: "q"}, fetchFn))
      .rejects.toThrow("Firecrawl search failed (HTTP 429).");
  });

  it("surfaces an application-level failure from the response body", async () => {
    const {fetchFn} = makeFetch({success: false, error: "quota exceeded"});
    await expect(firecrawlSearch(NO_KEY, {query: "q"}, fetchFn))
      .rejects.toThrow("Firecrawl search failed: quota exceeded");
  });

  it("reports an unknown error when success is false without a message", async () => {
    const {fetchFn} = makeFetch({success: false});
    await expect(firecrawlSearch(NO_KEY, {query: "q"}, fetchFn))
      .rejects.toThrow("Firecrawl search failed: unknown error");
  });

  it("turns an aborted fetch into a timeout error", async () => {
    const fetchFn = (async (_url: string, init: RequestInit) => {
      // Mimic what the runtime does when the abort signal fires mid-request.
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      expect(init.signal).toBeDefined();
      throw err;
    }) as unknown as typeof fetch;
    await expect(firecrawlSearch(NO_KEY, {query: "q"}, fetchFn))
      .rejects.toThrow(/timed out after 30000ms/);
  });
});

describe("formatFirecrawlResults", () => {
  it("says so when there are no hits", () => {
    expect(formatFirecrawlResults([])).toBe("No results.");
  });

  it("numbers hits and includes the publication date when present", () => {
    const text = formatFirecrawlResults([
      {source: "web", title: "Docs", url: "https://example.com/docs", snippet: "A description."},
      {source: "news", title: "Story", url: "https://news.example.com/1", snippet: "",
       publishedAt: "2026-08-01"},
    ]);
    expect(text).toBe(
      "1. [web] Docs\n   https://example.com/docs\n   A description.\n" +
      "2. [news] Story (2026-08-01)\n   https://news.example.com/1");
  });
});

// Built-in web search capability for the agent, backed by the Firecrawl API
// (https://docs.firecrawl.dev/api-reference/endpoint/search).
//
// Search only: page reading is already covered by the webFetch tool. Requests carry the
// deployment's Firecrawl API key and nothing about the user, and only the query text and
// result metadata (titles, URLs, snippets) flow through.

// Configuration for `firecrawlSearch`. Kept narrow so callers can pass a stub in tests
// without constructing a full Cloudflare.Env.
//
// The API key is OPTIONAL: Firecrawl serves unauthenticated requests on a keyless starter
// tier with rate limits shared per public egress IP (verified 2026-08-12 against
// /v2/search; also stated by the mcp.firecrawl.dev server banner). Installing a key only
// raises the limits.
export type FirecrawlSearchEnv = {
  apiKey?: string;
};

export type FirecrawlSearchInput = {
  query: string;
  // Per-source result cap. Clamped to 1..20; defaults to 10.
  limit?: number;
  // Result lists to search. Defaults to ["web"].
  sources?: ("web" | "news")[];
};

export type FirecrawlHit = {
  source: "web" | "news";
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
};

type FirecrawlSearchResponse = {
  success?: boolean;
  error?: string;
  data?: {
    web?: {title?: string, url?: string, description?: string}[];
    news?: {title?: string, url?: string, snippet?: string, date?: string}[];
  };
};

// Matches web-fetch.ts: without an abort the call can hang until the Worker's own limit,
// stalling the whole agent turn with no error returned to the model.
const FETCH_TIMEOUT_MS = 30_000;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 10;
  return Math.max(1, Math.min(20, Math.floor(limit)));
}

export async function firecrawlSearch(
    env: FirecrawlSearchEnv,
    input: FirecrawlSearchInput,
    fetchFn: typeof fetch = fetch): Promise<FirecrawlHit[]> {
  if (!input.query.trim()) {
    throw new Error("Search query must not be empty.");
  }
  let sources: ("web" | "news")[] =
      input.sources?.length ? [...new Set(input.sources)] : ["web"];

  let abortController = new AbortController();
  let timeoutId = setTimeout(() => abortController.abort(), FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetchFn("https://api.firecrawl.dev/v2/search", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(env.apiKey ? {"authorization": `Bearer ${env.apiKey}`} : {}),
      },
      body: JSON.stringify({query: input.query, limit: clampLimit(input.limit), sources}),
      signal: abortController.signal,
    });
  } catch (err) {
    if (err instanceof Error && (err.name === "AbortError" || /abort/i.test(err.message))) {
      throw new Error(`Firecrawl search timed out after ${FETCH_TIMEOUT_MS}ms`, {cause: err});
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
  if (!response.ok) {
    let hint = !env.apiKey && (response.status === 429 || response.status === 402)
        ? " The keyless tier's shared rate limit may be exhausted; installing a" +
          " FIRECRAWL_API_KEY secret raises the limits."
        : "";
    throw new Error(`Firecrawl search failed (HTTP ${response.status}).${hint}`);
  }
  let data = await response.json() as FirecrawlSearchResponse;
  if (data.success === false) {
    throw new Error(`Firecrawl search failed: ${data.error ?? "unknown error"}`);
  }

  let hits: FirecrawlHit[] = [];
  for (let hit of data.data?.web ?? []) {
    if (!hit.url) continue;
    hits.push({
      source: "web",
      title: hit.title ?? hit.url,
      url: hit.url,
      snippet: hit.description ?? "",
    });
  }
  for (let hit of data.data?.news ?? []) {
    if (!hit.url) continue;
    hits.push({
      source: "news",
      title: hit.title ?? hit.url,
      url: hit.url,
      snippet: hit.snippet ?? "",
      ...(hit.date ? {publishedAt: hit.date} : {}),
    });
  }
  return hits;
}

// Renders hits as a compact Markdown list, one entry per hit, mirroring how webFetch
// returns a single human-readable string rather than structured JSON.
export function formatFirecrawlResults(hits: FirecrawlHit[]): string {
  if (hits.length === 0) return "No results.";
  return hits.map((hit, i) => {
    let date = hit.publishedAt ? ` (${hit.publishedAt})` : "";
    let snippet = hit.snippet ? `\n   ${hit.snippet}` : "";
    return `${i + 1}. [${hit.source}] ${hit.title}${date}\n   ${hit.url}${snippet}`;
  }).join("\n");
}

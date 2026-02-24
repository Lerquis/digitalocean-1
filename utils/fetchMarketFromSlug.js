const { Client } = require("undici");

/**
 * Single persistent undici Client for polymarket.com.
 *
 * Benefits vs native fetch / https:
 *   - TCP+TLS handshake happens once; all subsequent requests reuse the socket
 *   - allowH2: true → negotiates HTTP/2 via ALPN (HPACK compression, no
 *     head-of-line blocking, ~20-30% less overhead than h1 keep-alive)
 *
 * DNS: pre-resolved at startup via dnsCache.preResolve(), which warms the OS
 * DNS cache (Windows DNS Client Service / Linux nscd). The first undici
 * connection benefits from that warm cache automatically.
 */
const client = new Client("https://polymarket.com", {
  allowH2: true,
});

/**
 * Fetch a Polymarket market by slug.
 * Scrapes the __NEXT_DATA__ payload from the event page — same approach
 * as the reference implementation in other-project/fetchMarketFromSlug.js.
 */
async function fetchMarketFromSlug(slug) {
  slug = slug.split("?")[0];

  const { statusCode, body } = await client.request({
    path: `/event/${slug}`,
    method: "GET",
    // Do NOT set accept-encoding: undici does not auto-decompress responses,
    // so if the server honors it we'd receive binary gzip/br instead of HTML.
    headers: {
      "user-agent": "Mozilla/5.0",
      accept: "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(10000),
  });

  if (statusCode !== 200) {
    await body.dump(); // drain body to free the connection slot
    throw new Error(`HTTP ${statusCode} fetching /event/${slug}`);
  }

  const html = await body.text();

  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
  if (!match) throw new Error("__NEXT_DATA__ payload not found on page");

  const payload = JSON.parse(match[1]);
  const queries = payload?.props?.pageProps?.dehydratedState?.queries || [];

  let market = null;
  for (const q of queries) {
    const data = q?.state?.data;
    if (data && typeof data === "object" && Array.isArray(data.markets)) {
      for (const mk of data.markets) {
        if (mk.slug === slug) {
          market = mk;
          break;
        }
      }
    }
    if (market) break;
  }

  if (!market) throw new Error("Market slug not found in dehydrated state");

  const clobTokens = market.clobTokenIds || [];
  const outcomes = market.outcomes || [];

  if (clobTokens.length !== 2 || outcomes.length !== 2) {
    throw new Error("Expected binary market with two clob tokens");
  }

  return {
    market_id: market.id || "",
    slug: market.slug,
    yes_token_id: clobTokens[0],
    no_token_id: clobTokens[1],
    outcomes,
    question: market.question || "",
    start_date: market.startDate,
    end_date: market.endDate,
  };
}

module.exports = fetchMarketFromSlug;

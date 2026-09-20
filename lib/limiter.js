// Shared scheduler for every request the OpenSea SDK makes. It is plugged into the SDK through
// its `fetch` option, so all wallets and all calls go through ONE limiter (the limit is per API key).
//
//  1. Spacing: requests are spaced at `currentRps`, which never goes above the cap `rps`.
//  2. On 429/599: ALL queued requests pause for Retry-After, the rate is halved, then it recovers
//     slowly back to the cap after a streak of successful requests.
//  3. GET /collections/{slug} is de-duplicated and cached briefly. The SDK re-fetches it for every
//     single listing although the collection is the same for the whole batch.

const COLLECTION_URL = /\/api\/v2\/collections\/[^/?#]+$/;
const RECOVERY_STREAK = 10;
const RECOVERY_FACTOR = 1.25;

function parseRetryAfter(header, now) {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return seconds > 0 ? Math.min(seconds, 300) : null;
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  const seconds = Math.ceil((date - now) / 1000);
  return seconds > 0 ? Math.min(seconds, 300) : null;
}

function createOpenSeaTransport({
  rps = 2,
  minRps = 0.5,
  collectionTtlMs = 120000,
  baseFetch = (...args) => globalThis.fetch(...args),
  clock = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const stats = { requests: 0, rateLimited: 0, cacheHits: 0 };
  let currentRps = rps;
  let nextSlot = 0;
  let pausedUntil = 0;
  let okStreak = 0;
  const cache = new Map();
  const inflight = new Map();

  async function acquire() {
    for (;;) {
      const now = clock();
      if (pausedUntil > now) {
        await sleep(pausedUntil - now);
        continue;
      }
      if (nextSlot <= now) {
        nextSlot = now + 1000 / currentRps;
        return;
      }
      await sleep(nextSlot - now);
    }
  }

  async function send(input, init) {
    await acquire();
    stats.requests += 1;
    const res = await baseFetch(input, init);

    if (res.status === 429 || res.status === 599) {
      stats.rateLimited += 1;
      okStreak = 0;
      currentRps = Math.max(minRps, currentRps / 2);
      const retryAfter = parseRetryAfter(res.headers.get('retry-after'), clock());
      pausedUntil = Math.max(pausedUntil, clock() + (retryAfter ?? 1) * 1000);
      nextSlot = pausedUntil; // restart evenly after the pause instead of bursting
    } else if (res.ok) {
      okStreak += 1;
      if (okStreak >= RECOVERY_STREAK && currentRps < rps) {
        currentRps = Math.min(rps, currentRps * RECOVERY_FACTOR);
        okStreak = 0;
      }
    }
    return res;
  }

  function toResponse(entry) {
    const headers = { 'content-type': entry.contentType };
    if (entry.retryAfter) headers['retry-after'] = entry.retryAfter;
    return new Response(entry.text, { status: entry.status, headers });
  }

  async function cachedCollection(url, input, init) {
    const hit = cache.get(url);
    if (hit && hit.expires > clock()) {
      stats.cacheHits += 1;
      return toResponse(hit);
    }

    const pending = inflight.get(url);
    if (pending) {
      stats.cacheHits += 1;
      return toResponse(await pending);
    }

    const request = (async () => {
      const res = await send(input, init);
      const entry = {
        status: res.status,
        text: await res.text(),
        contentType: res.headers.get('content-type') || 'application/json',
        retryAfter: res.headers.get('retry-after'),
        expires: clock() + collectionTtlMs,
      };
      if (res.status === 200) cache.set(url, entry);
      return entry;
    })();

    inflight.set(url, request);
    try {
      return toResponse(await request);
    } finally {
      inflight.delete(url);
    }
  }

  function transportFetch(input, init = {}) {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init.method || 'GET').toUpperCase();
    if (method === 'GET' && COLLECTION_URL.test(url)) {
      return cachedCollection(url, input, init);
    }
    return send(input, init);
  }

  function getStats() {
    return { ...stats, currentRps, capRps: rps };
  }

  return { fetch: transportFetch, getStats };
}

module.exports = { createOpenSeaTransport, parseRetryAfter };

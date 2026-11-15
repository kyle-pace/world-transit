// Live vehicles for one agency feed on the globe: /transit/api/globe/<feed id>.json
// (src/lib/globe-live.ts). Only feeds in src/lib/globe-live.json (written by
// scripts/build-globe.ts) are fetched, so this can't be used to fetch anything else.
// The answer is cached at the edge for 15 seconds, so each agency's feed is read at most
// about four times a minute per Cloudflare location, and never when nobody's looking.
// ?bbox=west,south,east,north trims the answer to that area: the whole feed is cached
// once, and each request gets only its part (Britain's feed is 11,000 vehicles).
import type { APIRoute } from 'astro';
import { compactFeed, fetchLiveFeed, trimBox, type GlobeLive } from '../../../../lib/globe-live';
import list from '../../../../lib/globe-live.json';

export const prerender = false;

const EDGE_SECONDS = 15;
const urls = new Map((list as { feeds: { id: string; url: string }[] }).feeds.map((f) => [f.id, f.url]));

const json = (body: unknown, status: number, cache: string) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': cache } });

export const GET: APIRoute = async ({ params, request, locals }) => {
  const url = urls.get(String(params.feed));
  if (!url) return json({ error: 'Unknown feed' }, 404, 'public, max-age=3600');

  const cache = typeof caches !== 'undefined' ? (caches as unknown as { default?: Cache }).default : undefined;
  const cacheKey = new Request(new URL(`/transit/api/globe/${params.feed}.json`, request.url).toString());
  let response = await cache?.match(cacheKey);
  if (!response) {
    try {
      response = json(compactFeed(await fetchLiveFeed(url, 10_000)), 200, `public, max-age=10, s-maxage=${EDGE_SECONDS}`);
    } catch (error) {
      // Cached briefly too, so a feed that's down isn't hammered by every viewer.
      const message = error instanceof Error ? error.message : String(error);
      response = json({ error: `The agency's feed didn't answer (${message.slice(0, 80)}).` }, 502, `public, max-age=10, s-maxage=${EDGE_SECONDS}`);
    }
    const ctx = (locals as { cfContext?: { waitUntil(p: Promise<unknown>): void } }).cfContext;
    if (cache && ctx) ctx.waitUntil(cache.put(cacheKey, response.clone()));
  }

  const box = trimBox(new URL(request.url).searchParams.get('bbox'));
  if (!box || !response.ok) return response;
  const full = (await response.json()) as GlobeLive;
  const [w, s, e, n] = box;
  return json({ ...full, v: full.v.filter(([, lon, lat]) => lon >= w && lon <= e && lat >= s && lat <= n) }, 200, 'public, max-age=10');
};


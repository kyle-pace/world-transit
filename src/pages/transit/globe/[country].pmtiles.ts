// The globe's tiles, /transit/globe/<country>.pmtiles, read from R2 (bucket
// kylepace-transit-tiles, binding TILES in wrangler.jsonc). The page's `pmtiles` library
// asks for a few KB at a time with HTTP range requests, so this answers those with
// 206 Partial Content. Served from this Worker, so the browser never talks to another host.
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

export const prerender = false;

interface R2Like {
  get(
    key: string,
    options?: { range?: Headers; onlyIf?: Headers },
  ): Promise<{
    body?: ReadableStream;
    size: number;
    httpEtag: string;
    range?: { offset?: number; length?: number; suffix?: number };
    writeHttpMetadata(h: Headers): void;
  } | null>;
}

const tiles = () => (env as unknown as { TILES?: R2Like }).TILES;

export const GET: APIRoute = async ({ params, request }) => {
  const country = String(params.country ?? '').toLowerCase();
  if (!/^[a-z]{2}$/.test(country)) return new Response('Not found', { status: 404 });
  const bucket = tiles();
  if (!bucket) return new Response('Tiles not configured', { status: 503 });

  const object = await bucket.get(`globe/${country}.pmtiles`, { range: request.headers, onlyIf: request.headers });
  if (!object) return new Response('Not found', { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('accept-ranges', 'bytes');
  // Tiles change at most weekly: an hour in the browser, then revalidated by ETag.
  headers.set('cache-control', 'public, max-age=3600');

  // A conditional request that matched (If-None-Match): R2 returns no body.
  if (!object.body) return new Response(null, { status: 304, headers });

  const r = object.range;
  if (r && request.headers.has('range')) {
    const offset = r.suffix !== undefined ? object.size - r.suffix : (r.offset ?? 0);
    const length = r.suffix !== undefined ? r.suffix : (r.length ?? object.size - offset);
    headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set('content-length', String(length));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set('content-length', String(object.size));
  return new Response(object.body, { headers });
};

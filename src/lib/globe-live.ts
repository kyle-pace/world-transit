/*
  Live vehicles for the globe (/world-transit/), one agency feed at a time.

  The Washington map reads all of its ~20 feeds on every request (src/lib/transit.ts).
  That doesn't scale to the hundreds of feeds across a country, so the globe asks for
  each feed separately (/world-transit/api/<feed>.json), and only for the feeds covering
  what's on screen. Each answer is cached at the edge for 15 seconds, so a feed nobody is
  looking at is never fetched.

  Used by the Worker endpoint and by scripts/build-globe.ts (to check each feed once
  before listing it). Erasable TypeScript and a relative import only, so Node runs it.

  Answer shape (arrays, to keep it small):
  { t: server time, age: feed age in seconds | null,
    v: [[id, lon, lat, bearing | null, route id, label, timestamp], ...] }
*/
import { decodeFeed, type FeedMessage } from './gtfs-rt.ts';

const USER_AGENT = 'kylepace.dev world transit (https://kylepace.dev/world-transit/)';
/** Positions older than this are parked or lost vehicles; leave them off the map. */
export const MAX_AGE_SECONDS = 15 * 60;

export type GlobeVehicle = [id: string, lon: number, lat: number, bearing: number | null, route: string, label: string, timestamp: number];

export interface GlobeLive {
  t: number;
  age: number | null;
  v: GlobeVehicle[];
}

const round5 = (n: number) => Math.round(n * 1e5) / 1e5;

/** Fetch and decode one GTFS-realtime vehicle positions feed. Throws on anything but protobuf. */
export async function fetchLiveFeed(url: string, timeoutMs = 6000): Promise<FeedMessage> {
  const res = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'application/x-protobuf, application/octet-stream, */*' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes[0] === 0x3c || bytes[0] === 0x7b) throw new Error('not protobuf (HTML or JSON answer)');
  return decodeFeed(bytes);
}

/** The compact answer: fresh vehicles with a real position only. */
export function compactFeed(feed: FeedMessage, now = Math.floor(Date.now() / 1000)): GlobeLive {
  const v: GlobeVehicle[] = [];
  for (const x of feed.vehicles) {
    if (!Number.isFinite(x.lat) || !Number.isFinite(x.lon) || (x.lat === 0 && x.lon === 0)) continue;
    if (Math.abs(x.lat) > 90 || Math.abs(x.lon) > 180) continue;
    const ts = x.timestamp || feed.timestamp;
    if (ts && now - ts > MAX_AGE_SECONDS) continue;
    v.push([x.id || x.label, round5(x.lon), round5(x.lat), x.bearing === null ? null : Math.round(x.bearing), x.routeId, x.label, ts]);
  }
  return { t: now, age: feed.timestamp ? now - feed.timestamp : null, v };
}

/** A ?bbox=west,south,east,north parameter, or null if it's missing or nonsense. */
export function trimBox(param: string | null): [number, number, number, number] | null {
  if (!param) return null;
  const parts = param.split(',').map(Number);
  if (parts.length !== 4 || parts.some((x) => !Number.isFinite(x))) return null;
  const [w, s, e, n] = parts;
  if (w > e || s > n || s < -90 || n > 90) return null;
  return [w, s, e, n];
}

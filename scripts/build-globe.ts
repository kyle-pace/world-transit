/*
  Build the globe's routes and stops for one country: node scripts/build-globe.ts [--country US]

  Reads every active GTFS schedule feed the Mobility Database lists for the country, runs
  each one through the same reader as the Washington map (build-transit.ts), and packs the
  lot into one vector-tile file, .globe-tmp/tiles/<country>.pmtiles, that the globe page
  reads a tile at a time.

  Why tiles: Washington's routes are one 4 MB JSON file. The whole US would be hundreds of
  MB, too much to send to a browser. Tiles cut the data into squares per zoom level, so the
  browser only loads what's on screen, simplified to the zoom it's shown at.

  Each feed's result is cached in .globe-tmp/out/, so a rerun only fetches feeds that
  failed or are new. Delete that folder to start fresh. Needs `unzip` and `tippecanoe`
  (brew install tippecanoe).

  Options:
    --country US       ISO country code from the catalog
    --limit 20         only the first N feeds (for trying it out)
    --concurrency 6    feeds processed at once
    --tiles-only       skip downloading; just repack the cached results
    --live-only        just recheck the live vehicle feeds (needs a finished build)
    --no-tiles         download only; pack the tiles in a later --tiles-only run
    --extra            also every open schedule in Transitland Atlas and Transitous that
                       the Mobility Database doesn't list (any country; cloned into
                       .globe-tmp/catalogs/ from GitHub)
    --upload           send the finished tiles to R2 (bucket kylepace-transit-tiles,
                       key globe/<country>.pmtiles), which the Worker serves at
                       /transit/globe/<country>.pmtiles. Needs `wrangler login`.
*/
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { download, findFiles, readGtfs } from './build-transit.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const TMP = join(root, '.globe-tmp');
const CACHE = join(TMP, 'out');
const CATALOG_URL = 'https://files.mobilitydatabase.org/feeds_v2.csv';

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
// Which countries to download this run. Tiles, counts and the live list always cover
// every feed cached so far, so countries add up run after run into one world file.
const COUNTRIES = new Set((arg('countries') ?? arg('country') ?? 'US').toUpperCase().split(',').map((c) => c.trim()).filter(Boolean));
const WORLD = 'world';
const LIMIT = Number(arg('limit', '0'));
const CONCURRENCY = Number(arg('concurrency', '6'));
const TILES_ONLY = process.argv.includes('--tiles-only');
const LIVE_ONLY = process.argv.includes('--live-only');
const NO_TILES = process.argv.includes('--no-tiles');
const EXTRA = process.argv.includes('--extra');
const CATALOGS = join(TMP, 'catalogs');
const UPLOAD = process.argv.includes('--upload');
const BUCKET = 'kylepace-transit-tiles';
const OUT_DIR = join(root, 'public/transit/globe');
// The tiles are too big to ship as a Worker asset (25 MB limit), so they stay out of
// public/ until they have a home; the local preview serves them from here.
const TILES_DIR = join(TMP, 'tiles');

const PALETTE = ['#2f6fdf', '#d6336c', '#0c8a6a', '#e8590c', '#7048e8', '#1098ad', '#c2255c', '#5c940d', '#ae3ec9', '#d9480f', '#1c7ed6', '#2b8a3e'];
// Only the files the reader uses; skips calendars, fares and transfers, which can be large.
const WANTED = ['agency.txt', 'routes.txt', 'trips.txt', 'shapes.txt', 'stops.txt', 'stop_times.txt'];

// Lines show from the zoom where they mean something: rail and ferries from the whole
// globe, buses once you're looking at a region, stops once you're looking at a city.
const MIN_ZOOM: Record<string, number> = { rail: 0, ferry: 0, tram: 3, other: 3, bus: 5 };
const STOP_MIN_ZOOM = 11;

interface Feed {
  id: string;
  provider: string;
  name: string;
  state: string;
  country: string;
  urls: string[];
}

// ---------- Catalog ----------

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cur);
      cur = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur);
      rows.push(row);
      row = [];
      cur = '';
    } else cur += ch;
  }
  if (cur || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

async function loadFeeds(): Promise<{ feeds: Feed[]; keyed: number }> {
  const file = join(TMP, 'feeds_v2.csv');
  // Refresh the catalog once a day.
  if (!existsSync(file) || Date.now() - statSync(file).mtimeMs > 86_400_000) {
    const res = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`catalog: HTTP ${res.status}`);
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  const [header, ...rows] = parseCsv(readFileSync(file, 'utf8'));
  const col = new Map(header.map((h, i) => [h, i]));
  const get = (r: string[], name: string) => r[col.get(name)!] ?? '';
  let keyed = 0;
  const feeds: Feed[] = [];
  for (const r of rows) {
    if (get(r, 'data_type') !== 'gtfs' || !COUNTRIES.has(get(r, 'location.country_code'))) continue;
    if (get(r, 'status') !== 'active' || get(r, 'redirect.id')) continue;
    // Feeds that need an API key are left out for now; the catalog's own copy (urls.latest)
    // usually still works for them, but their terms need reading first.
    if (get(r, 'urls.authentication_type') !== '0' && get(r, 'urls.authentication_type') !== '') {
      keyed++;
      continue;
    }
    const urls = [get(r, 'urls.latest'), get(r, 'urls.direct_download')].filter((u) => /^https?:\/\//.test(u));
    if (!urls.length) continue;
    feeds.push({ id: get(r, 'id'), provider: get(r, 'provider'), name: get(r, 'name'), state: get(r, 'location.subdivision_name'), country: get(r, 'location.country_code'), urls });
  }
  if (EXTRA) {
    const known = new Set<string>();
    for (const r of rows) for (const c of ['urls.direct_download', 'urls.latest']) if (get(r, c)) known.add(get(r, c).trim().replace(/\/$/, ''));
    feeds.push(...extraFeeds(known));
  }
  return { feeds: LIMIT ? feeds.slice(0, LIMIT) : feeds, keyed };
}

/**
 * Open schedules from Transitland Atlas and Transitous that the Mobility Database doesn't
 * list (by URL). Transitous files are named by country; Transitland doesn't say, so those
 * feeds get their country from where their routes are, once built (country-at.ts).
 */
function extraFeeds(known: Set<string>): Feed[] {
  const clone = (repo: string, dir: string) => {
    const path = join(CATALOGS, dir);
    if (existsSync(path)) spawnSync('git', ['-C', path, 'pull', '-q', '--depth', '1']);
    else spawnSync('git', ['clone', '-q', '--depth', '1', repo, path]);
    return path;
  };
  mkdirSync(CATALOGS, { recursive: true });
  // File-safe ids. Non-Latin ids would all shrink to the same few characters, so a short
  // hash of the original keeps every id unique.
  const safe = (s: string) => {
    let h = 0;
    for (const ch of s) h = (Math.imul(h, 31) + ch.codePointAt(0)!) >>> 0;
    return `${s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)}-${h.toString(36)}`;
  };
  const out: Feed[] = [];
  const add = (f: Feed) => {
    const u = f.urls[0].trim().replace(/\/$/, '');
    if (known.has(u)) return;
    known.add(u);
    out.push(f);
  };

  const atlas = clone('https://github.com/transitland/transitland-atlas.git', 'transitland-atlas');
  for (const file of readdirSync(join(atlas, 'feeds')).filter((f) => f.endsWith('.json')).sort()) {
    let dmfr: { feeds?: { id: string; spec?: string; urls?: { static_current?: string }; authorization?: unknown }[] };
    try {
      dmfr = JSON.parse(readFileSync(join(atlas, 'feeds', file), 'utf8'));
    } catch {
      continue;
    }
    for (const f of dmfr.feeds ?? []) {
      const url = f.urls?.static_current;
      if (f.spec !== 'gtfs' || !url || f.authorization || !/^https?:\/\//.test(url)) continue;
      add({ id: `tl-${safe(f.id)}`, provider: f.id, name: '', state: '', country: '', urls: [url] });
    }
  }

  const transitous = clone('https://github.com/public-transport/transitous.git', 'transitous');
  for (const file of readdirSync(join(transitous, 'feeds')).filter((f) => f.endsWith('.json')).sort()) {
    let cfg: { sources?: { name?: string; type?: string; url?: string; spec?: string; skip?: boolean; 'api-key'?: unknown; headers?: unknown }[] };
    try {
      cfg = JSON.parse(readFileSync(join(transitous, 'feeds', file), 'utf8'));
    } catch {
      continue;
    }
    const country = file.slice(0, 2).toUpperCase();
    for (const src of cfg.sources ?? []) {
      if (src.type !== 'http' || src.skip || (src.spec && src.spec !== 'gtfs') || !src.url || src.headers || src['api-key']) continue;
      if (!/^https?:\/\//.test(src.url)) continue;
      add({ id: `tr-${safe(file.replace(/\.json$/, ''))}-${safe(src.name ?? 'feed')}`, provider: src.name ?? file, name: '', state: file.replace(/\.json$/, ''), country, urls: [src.url] });
    }
  }
  console.log(`Extra catalogs: ${out.length} open schedules not in the Mobility Database.`);
  return out;
}

// ---------- One feed ----------

interface FeedResult {
  id: string;
  ok: boolean;
  provider: string;
  state: string;
  country?: string;
  crashed?: boolean;
  error?: string;
  source?: string;
  routes?: number;
  lines?: number;
  stops?: number;
  ms?: number;
}

async function buildFeed(feed: Feed, color: string): Promise<FeedResult> {
  const started = Date.now();
  const base = { id: feed.id, provider: feed.provider, state: feed.state, country: feed.country };
  const work = join(TMP, 'work', feed.id);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const zip = join(work, 'feed.zip');
  const dir = join(work, 'gtfs');
  try {
    let source = '';
    let lastError = '';
    for (const url of feed.urls) {
      try {
        await download(url, zip);
        source = url;
        break;
      } catch (e) {
        lastError = (e as Error).message;
      }
    }
    if (!source) throw new Error(`download failed: ${lastError}`);
    // Some zips keep their files in a subfolder, so match names anywhere in the archive.
    const extract = (from: string, to: string) => {
      spawnSync('unzip', ['-o', '-qq', '-C', from, ...WANTED, ...WANTED.map((f) => `*/${f}`), '-d', to]);
      // A few zips store their files without read permission.
      if (existsSync(to)) spawnSync('chmod', ['-R', 'u+rwX', to]);
      return existsSync(to) && existsSync(join(to)) && findFiles(to).has('routes.txt');
    };
    const dirs: string[] = [];
    if (extract(zip, dir)) dirs.push(dir);
    else {
      // A zip of zips (Public Transport Victoria ships one per mode): read each inner one.
      const inner = String(spawnSync('unzip', ['-Z1', zip]).stdout).split('\n').filter((n) => /\.zip$/i.test(n.trim()));
      if (!inner.length) throw new Error('no routes.txt or trips.txt in the zip');
      const innerDir = join(work, 'inner');
      spawnSync('unzip', ['-o', '-qq', zip, ...inner, '-d', innerDir]);
      inner.forEach((name, i) => {
        if (extract(join(innerDir, name.trim()), join(work, `gtfs-${i}`))) dirs.push(join(work, `gtfs-${i}`));
      });
      if (!dirs.length) throw new Error(`no routes.txt in any of ${inner.length} inner zips`);
    }
    rmSync(zip, { force: true });

    const lines: string[] = [];
    let drawn = 0;
    let routeCount = 0;
    let stopCount = 0;
    for (const d of dirs) {
      const bundle = await readGtfs({ key: feed.id, name: feed.provider }, d, color);
      routeCount += bundle.routes.length;
      stopCount += bundle.stops.length;
      for (const r of bundle.routes) {
        if (!r.geom.length) continue;
        drawn++;
        lines.push(
          JSON.stringify({
            type: 'Feature',
            tippecanoe: { layer: 'routes', minzoom: MIN_ZOOM[r.mode] ?? 5 },
            properties: { feed: feed.id, rid: r.id, agency: bundle.agencies[r.agency] ?? feed.provider, short: r.short, long: r.long, color: r.color, mode: r.mode },
            geometry: { type: 'MultiLineString', coordinates: r.geom },
          }),
        );
      }
      for (const st of bundle.stops) {
        lines.push(
          JSON.stringify({
            type: 'Feature',
            tippecanoe: { layer: 'stops', minzoom: STOP_MIN_ZOOM },
            properties: { feed: feed.id, name: st.name, routes: st.routes.length },
            geometry: { type: 'Point', coordinates: [st.lon, st.lat] },
          }),
        );
      }
    }
    // Feeds whose catalog doesn't say (Transitland): the country their first line starts in.
    if (!feed.country) {
      // Route lines are written before stops, so the first line is a route if there is one.
      const first = drawn ? JSON.parse(lines[0]) : null;
      if (first) {
        const { countryAt } = await import('./country-at.ts');
        const [lon, lat] = first.geometry.coordinates[0][0];
        base.country = countryAt(lon, lat);
      }
    }
    if (!drawn) throw new Error(`no route lines (${routeCount} routes, no shapes or stop sequences)`);
    writeFileSync(join(CACHE, `${feed.id}.ndjson`), lines.join('\n') + '\n');
    return { ...base, ok: true, source, routes: routeCount, lines: drawn, stops: stopCount, ms: Date.now() - started };
  } catch (e) {
    return { ...base, ok: false, error: (e as Error).message.slice(0, 300), ms: Date.now() - started };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Run one feed in its own Node process. Some feeds cover a whole country (Germany's has
 * millions of trips); if one runs out of memory, only that feed fails, the run goes on,
 * and the feed is tried again alone at the end with more room.
 */
function buildFeedIsolated(feed: Feed, color: string, heapMb = 3000): Promise<FeedResult> {
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn(process.execPath, [`--max-old-space-size=${heapMb}`, fileURLToPath(import.meta.url), '--one', JSON.stringify({ feed, color })], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      const last = out.trim().split('\n').pop() ?? '';
      try {
        done(JSON.parse(last));
      } catch {
        const oom = /heap out of memory|Allocation failed/i.test(err);
        done({ id: feed.id, provider: feed.provider, state: feed.state, country: feed.country, ok: false, crashed: true, error: oom ? 'ran out of memory' : `crashed (exit ${code}): ${err.trim().split('\n').pop()?.slice(0, 160)}`, ms: Date.now() - started });
      }
    });
  });
}

// ---------- Tiles ----------

// Mid-tones that hold up on the light and dark globe (same set as the live map's DISTINCT).
const DISTINCT = ['#2f6fdf', '#d6336c', '#0c8a6a', '#e8590c', '#7048e8', '#1098ad', '#c92a2a', '#5c940d', '#ae3ec9', '#e67700', '#1864ab', '#087f5b', '#a61e4d', '#4c6ef5'];

/** Relative luminance of a #rrggbb color, 0 (black) to 1 (white). */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

interface Counts {
  routes: number;
  stops: number;
  duplicates: number;
  osmOverlaps: number;
  longHopOnly: number;
  agencies: number;
  modes: Record<string, number>;
}

/**
 * Merge every cached feed into one routes file and one stops file for tippecanoe, fixing
 * three things on the way:
 * - The same feed is often listed twice in the catalog (King County Metro is), so a route
 *   whose agency, name, mode and path match one already seen is dropped.
 * - Many agencies paint every bus route one color, which turns a city into a solid mesh.
 *   Like the live map, each route in such a group gets its own color, cycling in route
 *   order; branded lines with their own color keep it.
 * - Near-black and near-white lines vanish on one of the two basemaps, so they're
 *   treated as having no color.
 * - OpenStreetMap lines (scripts/build-osm.ts) fill in where there are no schedules. Where
 *   a city has both, the OpenStreetMap copy of a route is dropped: schedules are read
 *   first and mark the ~300 m grid cells their lines pass through (rail and road
 *   separately), and an OpenStreetMap route mostly inside marked cells is skipped.
 * The agency's own color is kept as `official`.
 */
async function* readFeatures(file: string) {
  // Line by line: one region's OpenStreetMap file can pass Node's 512 MB string limit.
  for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) if (line) yield JSON.parse(line);
}

const CELL = 0.003; // degrees, about 300 m

// Lines built from stop to stop (the schedule had no drawn path) cut straight across
// everything when stops are far apart: an airport coach slices through a whole city. Such
// a line is broken wherever one hop is longer than this, in km; drawn paths are untouched.
const MAX_HOP_KM: Record<string, number> = { bus: 3, other: 3, tram: 3, rail: 60, ferry: Infinity };

function km(a: number[], b: number[]) {
  const dx = (a[0] - b[0]) * Math.cos(((a[1] + b[1]) / 2) * (Math.PI / 180)) * 111.32;
  const dy = (a[1] - b[1]) * 110.57;
  return Math.hypot(dx, dy);
}

/**
 * The zoom a line first shows at. From orbit, only long lines that define a continent;
 * shorter ones as you come down, so no low-zoom tile carries a whole country's regional
 * trains (Europe's were 2 MB a tile, and long lines alone still 1.4 MB at orbit). Buses and trams wait for region level.
 */
export function minZoomFor(mode: string, lines: number[][][]): number {
  if (mode === 'bus' || mode === 'other' || mode === 'tram') return 7;
  let length = 0;
  for (const line of lines) for (let i = 1; i < line.length; i++) length += km(line[i - 1], line[i]);
  if (mode === 'ferry') return length > 40 ? 3 : 6;
  // Thresholds tuned so an orbit tile stays a few hundred KB with the whole world in it.
  return length > 400 ? 0 : length > 120 ? 3 : length > 30 ? 5 : 6;
}

/**
 * From orbit, draw each corridor once. Country rail feeds often list every train as its
 * own route (China Railway: 4,600 routes on the same tracks filled the world tile), so a
 * line that would show below zoom 5 claims the ~25 km cells it crosses, and a later line
 * mostly on claimed cells waits until zoom 5, where tiles are small.
 */
const CORRIDOR = 0.25; // degrees
export function corridorZoom(minzoom: number, lines: number[][][], claimed: Set<number>): number {
  if (minzoom >= 5) return minzoom;
  const cells = new Set<number>();
  for (const line of lines) for (const [lon, lat] of line) cells.add(Math.floor((lon + 180) / CORRIDOR) * 10_000 + Math.floor((lat + 90) / CORRIDOR));
  let fresh = 0;
  for (const c of cells) if (!claimed.has(c)) fresh++;
  if (fresh < cells.size * 0.2) return 5;
  for (const c of cells) claimed.add(c);
  return minzoom;
}

/** A line whose points are (almost) all this feed's stops was drawn stop to stop. */
export function breakLongHops(lines: number[][][], stopsAt: Set<string>, mode: string): number[][][] {
  const limit = MAX_HOP_KM[mode] ?? 3;
  if (limit === Infinity) return lines;
  const out: number[][][] = [];
  for (const line of lines) {
    const onStops = line.filter((p) => stopsAt.has(`${p[0]},${p[1]}`)).length;
    if (onStops < line.length * 0.9) {
      out.push(line);
      continue;
    }
    let piece: number[][] = [line[0]];
    for (let i = 1; i < line.length; i++) {
      if (km(line[i - 1], line[i]) > limit) {
        if (piece.length >= 2) out.push(piece);
        piece = [line[i]];
      } else piece.push(line[i]);
    }
    if (piece.length >= 2) out.push(piece);
  }
  return out;
}
const cellOf = (lon: number, lat: number) => Math.floor((lon + 180) / CELL) * 100_000 + Math.floor((lat + 90) / CELL);
const isRail = (mode: string) => mode === 'rail' || mode === 'tram';

async function mergeFeeds(files: string[], routesOut: string, stopsOut: string): Promise<Counts> {
  const routes = createWriteStream(routesOut);
  const stops = createWriteStream(stopsOut);
  const seenRoutes = new Set<string>();
  const seenStops = new Set<string>();
  const counts: Counts = { routes: 0, stops: 0, duplicates: 0, osmOverlaps: 0, longHopOnly: 0, agencies: 0, modes: {} };
  const agencies = new Set<string>();
  const covered = { rail: new Set<number>(), road: new Set<number>() };
  const corridors = new Set<number>(); // cells claimed by lines drawn from orbit
  const write = async (stream: ReturnType<typeof createWriteStream>, f: unknown) => {
    if (!stream.write(JSON.stringify(f) + '\n')) await new Promise((r) => stream.once('drain', r));
  };
  const keep = (f: any) => {
    counts.routes++;
    counts.modes[f.properties.mode] = (counts.modes[f.properties.mode] ?? 0) + 1;
    agencies.add(f.properties.agency);
  };

  // Schedules first, so their grid is complete before any OpenStreetMap line is checked.
  const isOsm = (f: string) => basename(f).startsWith('osm-');
  const ordered = [...files.filter((f) => !isOsm(f)), ...files.filter(isOsm)];
  for (const file of ordered) {
    if (isOsm(file)) {
      for await (const f of readFeatures(file)) {
        const p = f.properties;
        const grid = isRail(p.mode) ? covered.rail : covered.road;
        let pts = 0;
        let inside = 0;
        for (const line of f.geometry.coordinates) for (let i = 0; i < line.length; i += 2) {
          pts++;
          if (grid.has(cellOf(line[i][0], line[i][1]))) inside++;
        }
        if (pts && inside / pts > 0.6) {
          counts.osmOverlaps++;
          continue;
        }
        p.official = p.color;
        delete f.tippecanoe.layer;
        f.tippecanoe.minzoom = corridorZoom(minZoomFor(p.mode, f.geometry.coordinates), f.geometry.coordinates, corridors);
        await write(routes, f);
        keep(f);
      }
      continue;
    }
    // This feed's stop positions, to tell stop-to-stop lines from drawn ones.
    const stopsAt = new Set<string>();
    for await (const f of readFeatures(file)) if (f.tippecanoe.layer === 'stops') stopsAt.add(`${f.geometry.coordinates[0]},${f.geometry.coordinates[1]}`);
    const groups = new Map<string, any[]>();
    for await (const f of readFeatures(file)) {
      const p = f.properties;
      if (f.tippecanoe.layer === 'stops') {
        const [lon, lat] = f.geometry.coordinates;
        const key = `${p.name}|${lon.toFixed(4)}|${lat.toFixed(4)}`;
        if (seenStops.has(key)) continue;
        seenStops.add(key);
        delete f.tippecanoe.layer;
        await write(stops, f);
        counts.stops++;
        continue;
      }
      f.geometry.coordinates = breakLongHops(f.geometry.coordinates, stopsAt, p.mode);
      if (!f.geometry.coordinates.length) {
        counts.longHopOnly++;
        continue;
      }
      const first = f.geometry.coordinates[0][0];
      const key = `${p.agency}|${p.short}|${p.long}|${p.mode}|${first[0].toFixed(3)},${first[1].toFixed(3)}`;
      if (seenRoutes.has(key)) {
        counts.duplicates++;
        continue;
      }
      seenRoutes.add(key);
      const grid = isRail(p.mode) ? covered.rail : covered.road;
      for (const line of f.geometry.coordinates) for (const [lon, lat] of line) grid.add(cellOf(lon, lat));
      p.official = p.color;
      const lum = luminance(p.color);
      const unusable = lum < 0.02 || lum > 0.8;
      const groupKey = `${p.agency}|${unusable ? 'none' : p.color}|${p.mode}`;
      groups.set(groupKey, [...(groups.get(groupKey) ?? []), f]);
    }
    for (const [key, members] of groups) {
      // Recolor a group that shares one color, or any route whose color can't be seen.
      if (members.length >= 4 || key.includes('|none|')) members.forEach((f, n) => (f.properties.color = DISTINCT[n % DISTINCT.length]));
      for (const f of members) {
        delete f.tippecanoe.layer;
        f.tippecanoe.minzoom = corridorZoom(minZoomFor(f.properties.mode, f.geometry.coordinates), f.geometry.coordinates, corridors);
        await write(routes, f);
        keep(f);
      }
    }
  }
  // Wait until both files are fully written before tippecanoe reads them.
  await Promise.all([routes, stops].map((s) => new Promise((done) => s.end(done))));
  counts.agencies = agencies.size;
  return counts;
}

async function buildTiles(): Promise<{ out: string; counts: Counts }> {
  const cached = readdirSync(CACHE).filter((f) => f.endsWith('.ndjson'));
  if (!cached.length) throw new Error('nothing cached to tile');
  const input = join(TMP, 'tiles-input');
  rmSync(input, { recursive: true, force: true });
  mkdirSync(input, { recursive: true });
  const routesFile = join(input, 'routes.ndjson');
  const stopsFile = join(input, 'stops.ndjson');
  // Sorted, so the same feeds always win a duplicate and colors stay put between builds.
  const counts = await mergeFeeds(cached.sort().map((f) => join(CACHE, f)), routesFile, stopsFile);
  mkdirSync(TILES_DIR, { recursive: true });
  const out = join(TILES_DIR, `${WORLD}.pmtiles`);
  const tmpOut = `${out}.tmp.pmtiles`;
  const t = spawnSync(
    'tippecanoe',
    [
      '-o', tmpOut, '--force', '--quiet',
      '--minimum-zoom=0', '--maximum-zoom=13',
      // Keep every line at every zoom it's allowed in, simplifying instead of dropping,
      // until a tile gets too big; then drop the least important (shortest) first.
      '--simplification=8', '--simplify-only-low-zooms',
      '--drop-smallest-as-needed', '--coalesce-smallest-as-needed',
      '--extend-zooms-if-still-dropping',
      // Twice the default tile size, so central London and Paris keep every line whole
      // instead of being thinned; only the densest city tiles get this big.
      '--maximum-tile-bytes=1000000',
      '--read-parallel',
      // Named layers from one file each. (With hundreds of input files, tippecanoe
      // put some features in layers named after the file instead.)
      '-L', `routes:${routesFile}`,
      '-L', `stops:${stopsFile}`,
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );
  if (t.status !== 0) throw new Error(`tippecanoe failed (${t.status})`);
  // Swap in only once the new file is complete, so a failed run never leaves a broken one.
  rmSync(out, { force: true });
  spawnSync('mv', [tmpOut, out]);
  return { out, counts };
}

// ---------- Summary (counts for the globe page's sign) ----------

function writeSummary(reportFile: string, counts: Counts) {
  const osmFile = join(TMP, 'report-osm.json');
  const report: Record<string, FeedResult> = {
    ...(existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, 'utf8')) : {}),
    // OpenStreetMap regions (scripts/build-osm.ts), counted like feeds.
    ...(existsSync(osmFile) ? JSON.parse(readFileSync(osmFile, 'utf8')) : {}),
  };
  const summary = {
    updated: new Date().toISOString(),
    countries: [...new Set(Object.values(report).filter((r) => r.ok).map((r) => r.country ?? 'US'))].sort(),
    feeds: Object.values(report).filter((r) => r.ok).length,
    failed: Object.values(report).filter((r) => !r.ok).length,
    ...counts,
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, `${WORLD}.json`), JSON.stringify(summary, null, 1) + '\n');
  console.log(`Summary: ${summary.feeds} feeds, ${summary.agencies} agencies, ${counts.routes} routes (${counts.duplicates} duplicates and ${counts.osmOverlaps} OpenStreetMap copies of scheduled routes dropped, ${counts.longHopOnly} stop-to-stop routes with nothing short enough to draw), ${counts.stops} stops.`);
}

// ---------- Live feeds (vehicle positions) ----------

interface LiveFeed {
  id: string;
  name: string;
  url: string;
  /** The schedule feed whose routes and stops this feed's vehicles run on. */
  static: string;
  /** [west, south, east, north] of that schedule's routes and stops. */
  bbox: [number, number, number, number];
  /** Vehicles in the feed when the build checked it (0 at night is normal). */
  vehicles: number;
}

const routeKey = (p: { agency: string; short: string; long: string; mode: string }, first: number[]) =>
  `${p.agency}|${p.short}|${p.long}|${p.mode}|${first[0].toFixed(3)},${first[1].toFixed(3)}`;

/**
 * List every open live vehicle feed for the country that belongs to a schedule on the
 * globe and answers right now, plus a route lookup for each (route id -> name, color),
 * so the page can say what a vehicle is and color it like its line.
 *
 * Writes src/lib/globe-live.json (the Worker reads feed URLs from it, the page reads
 * ids and areas) and public/transit/globe/routes/<schedule>.json. If no feed answers at
 * all (the network is down), nothing is written and the last list stays.
 */
async function buildLiveList() {
  const { fetchLiveFeed, compactFeed } = await import('../src/lib/globe-live.ts');
  const [header, ...rows] = parseCsv(readFileSync(join(TMP, 'feeds_v2.csv'), 'utf8'));
  const col = new Map(header.map((h, i) => [h, i]));
  const get = (r: string[], name: string) => r[col.get(name)!] ?? '';

  const candidates: Omit<LiveFeed, 'bbox' | 'vehicles'>[] = [];
  const seenUrls = new Set<string>();
  let keyed = 0;
  let noSchedule = 0;
  for (const r of rows) {
    if (get(r, 'data_type') !== 'gtfs_rt') continue;
    if (!get(r, 'entity_type').split('|').includes('vp')) continue;
    if (['deprecated', 'inactive'].includes(get(r, 'status')) || get(r, 'redirect.id')) continue;
    if (!['0', ''].includes(get(r, 'urls.authentication_type'))) {
      keyed++;
      continue;
    }
    const url = get(r, 'urls.direct_download');
    if (!/^https?:\/\//.test(url) || seenUrls.has(url)) continue;
    const schedule = get(r, 'static_reference').split('|').find((s) => existsSync(join(CACHE, `${s}.ndjson`)));
    if (!schedule) {
      noSchedule++;
      continue;
    }
    seenUrls.add(url);
    candidates.push({ id: get(r, 'id'), name: get(r, 'provider') || get(r, 'name'), url, static: schedule });
  }
  console.log(`\nLive: ${candidates.length} open vehicle feeds with a schedule on the globe (${keyed} need a key, ${noSchedule} have no schedule on the globe). Checking each…`);

  // Final line colors, after duplicates and recoloring (the merged file tippecanoe read).
  const finalColor = new Map<string, string>();
  for await (const f of readFeatures(join(TMP, 'tiles-input', 'routes.ndjson'))) {
    if (f.properties.source === 'osm') continue;
    finalColor.set(routeKey(f.properties, f.geometry.coordinates[0][0]), f.properties.color);
  }

  const results: (LiveFeed | null)[] = new Array(candidates.length).fill(null);
  const problems: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < candidates.length) {
      const i = next++;
      const c = candidates[i];
      try {
        const live = compactFeed(await fetchLiveFeed(c.url, 10_000));
        let [w, s, e, n] = [180, 90, -180, -90];
        for await (const feature of readFeatures(join(CACHE, `${c.static}.ndjson`))) {
          const g = feature.geometry;
          const pts: number[][] = g.type === 'Point' ? [g.coordinates] : g.coordinates.flat();
          for (const [x, y] of pts) {
            if (x < w) w = x;
            if (x > e) e = x;
            if (y < s) s = y;
            if (y > n) n = y;
          }
        }
        results[i] = { ...c, bbox: [w, s, e, n].map((v) => Math.round(v * 1000) / 1000) as LiveFeed['bbox'], vehicles: live.v.length };
      } catch (err) {
        problems.push(`${c.id} ${c.name}: ${(err as Error).message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: 16 }, worker));
  const feeds = results.filter((r): r is LiveFeed => r !== null).sort((a, b) => a.id.localeCompare(b.id));
  if (!feeds.length) throw new Error('no live feed answered; keeping the last list');

  const routesDir = join(OUT_DIR, 'routes');
  rmSync(routesDir, { recursive: true, force: true });
  mkdirSync(routesDir, { recursive: true });
  for (const schedule of new Set(feeds.map((f) => f.static))) {
    // route id -> [short name, long name, color, mode, agency]
    const lookup: Record<string, [string, string, string, string, string]> = {};
    for await (const f of readFeatures(join(CACHE, `${schedule}.ndjson`))) {
      if (f.tippecanoe.layer !== 'routes') continue;
      const p = f.properties;
      lookup[p.rid] = [p.short, p.long, finalColor.get(routeKey(p, f.geometry.coordinates[0][0])) ?? p.color, p.mode, p.agency];
    }
    writeFileSync(join(routesDir, `${schedule}.json`), JSON.stringify(lookup));
  }
  writeFileSync(
    join(root, 'src/lib/globe-live.json'),
    JSON.stringify({ updated: new Date().toISOString(), feeds }, null, 1) + '\n',
  );
  const moving = feeds.reduce((sum, f) => sum + f.vehicles, 0);
  console.log(`Live: ${feeds.length} feeds answered (${moving} vehicles right now), ${problems.length} didn't:`);
  for (const p of problems.sort()) console.log(`  ${p}`);
}

// ---------- Main ----------

async function main() {
  mkdirSync(CACHE, { recursive: true });
  // Child mode (buildFeedIsolated): build one feed and print its result as the last line.
  if (process.argv.includes('--one')) {
    const { feed, color } = JSON.parse(arg('one')!);
    console.log(JSON.stringify(await buildFeed(feed, color)));
    return;
  }
  const reportFile = join(TMP, 'report.json');
  const previous: Record<string, FeedResult> = existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, 'utf8')) : {};

  if (LIVE_ONLY) return buildLiveList();

  if (!TILES_ONLY) {
    const { feeds, keyed } = await loadFeeds();
    const todo = feeds.filter((f) => !existsSync(join(CACHE, `${f.id}.ndjson`)));
    console.log(`${[...COUNTRIES].join(', ')}: ${feeds.length} open feeds (${keyed} need a key, skipped); ${feeds.length - todo.length} cached, ${todo.length} to fetch.`);
    const report: Record<string, FeedResult> = { ...previous };
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < todo.length) {
        const i = next++;
        const feed = todo[i];
        const r = await buildFeedIsolated(feed, PALETTE[Number(feed.id.replace(/\D/g, '')) % PALETTE.length]);
        report[feed.id] = r;
        done++;
        console.log(`[${done}/${todo.length}] ${r.ok ? 'ok  ' : 'FAIL'} ${feed.id} ${feed.provider}${r.ok ? ` (${r.lines} lines, ${r.stops} stops, ${Math.round(r.ms! / 1000)}s)` : `: ${r.error}`}`);
        // Save as we go, so a crash or Ctrl-C keeps what's done.
        if (done % 10 === 0) writeFileSync(reportFile, JSON.stringify(report, null, 1));
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    // Feeds that crashed (usually out of memory with others running): once more, alone,
    // with most of the machine's memory.
    for (const feed of todo.filter((f) => report[f.id]?.crashed)) {
      console.log(`Retrying ${feed.id} ${feed.provider} alone…`);
      const r = await buildFeedIsolated(feed, PALETTE[Number(feed.id.replace(/\D/g, '')) % PALETTE.length], 6000);
      report[feed.id] = r;
      console.log(`  ${r.ok ? 'ok' : 'FAIL'}${r.ok ? ` (${r.lines} lines, ${r.stops} stops)` : `: ${r.error}`}`);
    }
    writeFileSync(reportFile, JSON.stringify(report, null, 1));
    const results = Object.values(report);
    console.log(`\n${results.filter((r) => r.ok).length} feeds ok, ${results.filter((r) => !r.ok).length} failed. Report: ${reportFile}`);
  }

  if (NO_TILES) return;
  const { out, counts } = await buildTiles();
  console.log(`Tiles: ${out} (${Math.round(statSync(out).size / 1e6)} MB)`);
  writeSummary(reportFile, counts);
  // A live-feed problem never costs the routes: the tiles are already written.
  try {
    await buildLiveList();
  } catch (err) {
    console.log(`::warning title=Live feeds not updated::${(err as Error).message}`);
  }
  if (UPLOAD) {
    const key = `${BUCKET}/globe/${WORLD}.pmtiles`;
    const up = spawnSync('npx', ['wrangler', 'r2', 'object', 'put', key, '--file', out, '--content-type', 'application/octet-stream', '--remote'], { stdio: 'inherit', cwd: root });
    if (up.status !== 0) throw new Error('upload to R2 failed');
    console.log(`Uploaded to R2: ${key}`);
  }
}

// Run only when started directly (or as a feed's child process), not when tests import it.
if (import.meta.main) await main();

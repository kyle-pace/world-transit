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
    --upload           send the finished tiles to R2 (bucket kylepace-transit-tiles,
                       key globe/<country>.pmtiles), which the Worker serves at
                       /transit/globe/<country>.pmtiles. Needs `wrangler login`.
*/
import { spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { download, readGtfs } from './build-transit.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const TMP = join(root, '.globe-tmp');
const CACHE = join(TMP, 'out');
const CATALOG_URL = 'https://files.mobilitydatabase.org/feeds_v2.csv';

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const COUNTRY = (arg('country', 'US') as string).toUpperCase();
const LIMIT = Number(arg('limit', '0'));
const CONCURRENCY = Number(arg('concurrency', '6'));
const TILES_ONLY = process.argv.includes('--tiles-only');
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
    if (get(r, 'data_type') !== 'gtfs' || get(r, 'location.country_code') !== COUNTRY) continue;
    if (get(r, 'status') !== 'active' || get(r, 'redirect.id')) continue;
    // Feeds that need an API key are left out for now; the catalog's own copy (urls.latest)
    // usually still works for them, but their terms need reading first.
    if (get(r, 'urls.authentication_type') !== '0' && get(r, 'urls.authentication_type') !== '') {
      keyed++;
      continue;
    }
    const urls = [get(r, 'urls.latest'), get(r, 'urls.direct_download')].filter((u) => /^https?:\/\//.test(u));
    if (!urls.length) continue;
    feeds.push({ id: get(r, 'id'), provider: get(r, 'provider'), name: get(r, 'name'), state: get(r, 'location.subdivision_name'), urls });
  }
  return { feeds: LIMIT ? feeds.slice(0, LIMIT) : feeds, keyed };
}

// ---------- One feed ----------

interface FeedResult {
  id: string;
  ok: boolean;
  provider: string;
  state: string;
  error?: string;
  source?: string;
  routes?: number;
  lines?: number;
  stops?: number;
  ms?: number;
}

async function buildFeed(feed: Feed, color: string): Promise<FeedResult> {
  const started = Date.now();
  const base = { id: feed.id, provider: feed.provider, state: feed.state };
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
    const unzip = spawnSync('unzip', ['-o', '-qq', '-C', zip, ...WANTED, ...WANTED.map((f) => `*/${f}`), '-d', dir]);
    if (!existsSync(dir)) throw new Error(`unzip failed: ${String(unzip.stderr).trim().slice(0, 200)}`);
    // A few zips store their files without read permission.
    spawnSync('chmod', ['-R', 'u+rwX', dir]);
    rmSync(zip, { force: true });

    const bundle = await readGtfs({ key: feed.id, name: feed.provider }, dir, color);
    const lines: string[] = [];
    let drawn = 0;
    for (const r of bundle.routes) {
      if (!r.geom.length) continue;
      drawn++;
      lines.push(
        JSON.stringify({
          type: 'Feature',
          tippecanoe: { layer: 'routes', minzoom: MIN_ZOOM[r.mode] ?? 5 },
          properties: { feed: feed.id, agency: bundle.agencies[r.agency] ?? feed.provider, short: r.short, long: r.long, color: r.color, mode: r.mode },
          geometry: { type: 'MultiLineString', coordinates: r.geom },
        }),
      );
    }
    for (const s of bundle.stops) {
      lines.push(
        JSON.stringify({
          type: 'Feature',
          tippecanoe: { layer: 'stops', minzoom: STOP_MIN_ZOOM },
          properties: { feed: feed.id, name: s.name, routes: s.routes.length },
          geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
        }),
      );
    }
    if (!drawn) throw new Error(`no route lines (${bundle.routes.length} routes, no shapes or stop sequences)`);
    writeFileSync(join(CACHE, `${feed.id}.ndjson`), lines.join('\n') + '\n');
    return { ...base, ok: true, source, routes: bundle.routes.length, lines: drawn, stops: bundle.stops.length, ms: Date.now() - started };
  } catch (e) {
    return { ...base, ok: false, error: (e as Error).message.slice(0, 300), ms: Date.now() - started };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
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
 * The agency's own color is kept as `official`.
 */
async function mergeFeeds(files: string[], routesOut: string, stopsOut: string): Promise<Counts> {
  const routes = createWriteStream(routesOut);
  const stops = createWriteStream(stopsOut);
  const seenRoutes = new Set<string>();
  const seenStops = new Set<string>();
  const counts: Counts = { routes: 0, stops: 0, duplicates: 0, agencies: 0, modes: {} };
  const agencies = new Set<string>();
  for (const file of files) {
    const features = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const groups = new Map<string, any[]>();
    for (const f of features) {
      const p = f.properties;
      if (f.tippecanoe.layer === 'stops') {
        const [lon, lat] = f.geometry.coordinates;
        const key = `${p.name}|${lon.toFixed(4)}|${lat.toFixed(4)}`;
        if (seenStops.has(key)) continue;
        seenStops.add(key);
        delete f.tippecanoe.layer;
        stops.write(JSON.stringify(f) + '\n');
        counts.stops++;
        continue;
      }
      const first = f.geometry.coordinates[0][0];
      const key = `${p.agency}|${p.short}|${p.long}|${p.mode}|${first[0].toFixed(3)},${first[1].toFixed(3)}`;
      if (seenRoutes.has(key)) {
        counts.duplicates++;
        continue;
      }
      seenRoutes.add(key);
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
        routes.write(JSON.stringify(f) + '\n');
        counts.routes++;
        counts.modes[f.properties.mode] = (counts.modes[f.properties.mode] ?? 0) + 1;
        agencies.add(f.properties.agency);
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
  const out = join(TILES_DIR, `${COUNTRY.toLowerCase()}.pmtiles`);
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
  const report: Record<string, FeedResult> = existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, 'utf8')) : {};
  const summary = {
    updated: new Date().toISOString(),
    country: COUNTRY,
    feeds: Object.values(report).filter((r) => r.ok).length,
    failed: Object.values(report).filter((r) => !r.ok).length,
    ...counts,
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, `${COUNTRY.toLowerCase()}.json`), JSON.stringify(summary, null, 1) + '\n');
  console.log(`Summary: ${summary.feeds} feeds, ${summary.agencies} agencies, ${counts.routes} routes (${counts.duplicates} duplicates dropped), ${counts.stops} stops.`);
}

// ---------- Main ----------

async function main() {
  mkdirSync(CACHE, { recursive: true });
  const reportFile = join(TMP, `report-${COUNTRY.toLowerCase()}.json`);
  const previous: Record<string, FeedResult> = existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, 'utf8')) : {};

  if (!TILES_ONLY) {
    const { feeds, keyed } = await loadFeeds();
    const todo = feeds.filter((f) => !existsSync(join(CACHE, `${f.id}.ndjson`)));
    console.log(`${COUNTRY}: ${feeds.length} open feeds (${keyed} need a key, skipped); ${feeds.length - todo.length} cached, ${todo.length} to fetch.`);
    const report: Record<string, FeedResult> = { ...previous };
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < todo.length) {
        const i = next++;
        const feed = todo[i];
        const r = await buildFeed(feed, PALETTE[Number(feed.id.replace(/\D/g, '')) % PALETTE.length]);
        report[feed.id] = r;
        done++;
        console.log(`[${done}/${todo.length}] ${r.ok ? 'ok  ' : 'FAIL'} ${feed.id} ${feed.provider}${r.ok ? ` (${r.lines} lines, ${r.stops} stops, ${Math.round(r.ms! / 1000)}s)` : `: ${r.error}`}`);
        // Save as we go, so a crash or Ctrl-C keeps what's done.
        if (done % 10 === 0) writeFileSync(reportFile, JSON.stringify(report, null, 1));
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    writeFileSync(reportFile, JSON.stringify(report, null, 1));
    const results = Object.values(report);
    console.log(`\n${results.filter((r) => r.ok).length} feeds ok, ${results.filter((r) => !r.ok).length} failed. Report: ${reportFile}`);
  }

  const { out, counts } = await buildTiles();
  console.log(`Tiles: ${out} (${Math.round(statSync(out).size / 1e6)} MB)`);
  writeSummary(reportFile, counts);
  if (UPLOAD) {
    const key = `${BUCKET}/globe/${COUNTRY.toLowerCase()}.pmtiles`;
    const up = spawnSync('npx', ['wrangler', 'r2', 'object', 'put', key, '--file', out, '--content-type', 'application/octet-stream', '--remote'], { stdio: 'inherit', cwd: root });
    if (up.status !== 0) throw new Error('upload to R2 failed');
    console.log(`Uploaded to R2: ${key}`);
  }
}

await main();

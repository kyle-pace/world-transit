/*
  Transit lines from OpenStreetMap, for places with no open schedules:
  node scripts/build-osm.ts asia/china:CN russia:RU africa/nigeria:NG ...

  Each argument is a Geofabrik extract path (download.geofabrik.de/<path>-latest.osm.pbf)
  and the country it counts toward. For each one:
  1. download the extract (deleted again afterward; some are gigabytes),
  2. keep only transit route relations and the ways they use (osmium tags-filter),
  3. turn those ways into lines (osmium export),
  4. join each route's ways into one line with its name, number, color and operator,
  and write .globe-tmp/out/osm-<name>.ndjson in the same shape as a schedule feed, so
  scripts/build-globe.ts --tiles-only packs it in with everything else.

  OpenStreetMap shows where lines run, not when: no timetables, and no live vehicles
  (those need a schedule's trip ids). Data © OpenStreetMap contributors (ODbL).
  Needs osmium (brew install osmium-tool).
*/
import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { cleanLine } from './build-transit.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const TMP = join(root, '.globe-tmp');
const OSM = join(TMP, 'osm');
const CACHE = join(TMP, 'out');
const KEEP = process.argv.includes('--keep');

const ROUTES = ['bus', 'trolleybus', 'minibus', 'share_taxi', 'tram', 'light_rail', 'subway', 'monorail', 'train', 'ferry', 'funicular'];
const MODE: Record<string, string> = {
  bus: 'bus', trolleybus: 'bus', minibus: 'bus', share_taxi: 'bus',
  tram: 'tram', light_rail: 'tram',
  subway: 'rail', monorail: 'rail', train: 'rail',
  ferry: 'ferry', funicular: 'other',
};
const MIN_ZOOM: Record<string, number> = { rail: 0, ferry: 0, tram: 3, other: 3, bus: 5 };
const PALETTE = ['#2f6fdf', '#d6336c', '#0c8a6a', '#e8590c', '#7048e8', '#1098ad', '#c2255c', '#5c940d', '#ae3ec9', '#d9480f', '#1c7ed6', '#2b8a3e'];

function run(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'inherit', 'pipe'], maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`${cmd} ${args[0]} failed: ${String(r.stderr).trim().slice(0, 300)}`);
}

/** OPL escapes: %20% is a space, %2c% a comma, and so on. */
const unescape = (s: string) => s.replace(/%([0-9a-f]+)%/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));

export function tagsOf(field: string): Record<string, string> {
  const tags: Record<string, string> = {};
  if (!field) return tags;
  for (const pair of field.split(',')) {
    const i = pair.indexOf('=');
    if (i > 0) tags[unescape(pair.slice(0, i))] = unescape(pair.slice(i + 1));
  }
  return tags;
}

export function colorOf(tag: string | undefined, fallback: string): string {
  const c = (tag ?? '').trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(c)) return c;
  if (/^#[0-9a-f]{3}$/.test(c)) return `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`;
  return fallback;
}

async function buildRegion(path: string, country: string) {
  const name = path.split('/').pop()!;
  const id = `osm-${name}`;
  const started = Date.now();
  const pbf = join(OSM, 'dl', `${name}.osm.pbf`);
  const routesPbf = join(OSM, `${name}-routes.osm.pbf`);
  const ways = join(OSM, `${name}-ways.geojsonseq`);
  mkdirSync(join(OSM, 'dl'), { recursive: true });

  if (!existsSync(pbf)) {
    console.log(`${id}: downloading ${path}…`);
    run('curl', ['-sSfL', '--retry', '3', '-o', `${pbf}.part`, `https://download.geofabrik.de/${path}-latest.osm.pbf`]);
    spawnSync('mv', [`${pbf}.part`, pbf]);
  }
  console.log(`${id}: ${Math.round(statSync(pbf).size / 1e6)} MB, filtering…`);
  run('osmium', ['tags-filter', pbf, `r/route=${ROUTES.join(',')}`, '-o', routesPbf, '--overwrite', '--no-progress']);
  if (!KEEP) rmSync(pbf, { force: true });
  run('osmium', ['export', routesPbf, '-f', 'geojsonseq', '--geometry-types=linestring', '--add-unique-id=type_id', '-o', ways, '--overwrite', '--no-progress']);

  // Way id -> its line, simplified like schedule shapes.
  const wayLines = new Map<string, number[][]>();
  for await (const raw of createInterface({ input: createReadStream(ways), crlfDelay: Infinity })) {
    const line = raw.replace(/^\x1e/, '').trim();
    if (!line) continue;
    const f = JSON.parse(line);
    if (f.geometry?.type !== 'LineString') continue;
    const pts = cleanLine(f.geometry.coordinates);
    if (pts.length >= 2) wayLines.set(f.id, pts);
  }

  // Relations: tags and member ways, from osmium's plain-text (OPL) output.
  const opl = spawnSync('osmium', ['cat', routesPbf, '-t', 'relation', '-f', 'opl'], { maxBuffer: 1 << 30 });
  if (opl.status !== 0) throw new Error(`osmium cat failed: ${String(opl.stderr).slice(0, 200)}`);
  const out: string[] = [];
  let routes = 0;
  const modes: Record<string, number> = {};
  for (const line of String(opl.stdout).split('\n')) {
    const rel = parseRelation(line);
    if (!rel) continue;
    const { id: rid, tags } = rel;
    const mode = MODE[tags.route];
    if (!mode || tags.disused || tags['disused:route']) continue;
    const geom: number[][][] = [];
    for (const w of rel.ways) {
      const way = wayLines.get(w);
      if (way) geom.push(way);
    }
    if (!geom.length) continue;
    routes++;
    modes[mode] = (modes[mode] ?? 0) + 1;
    out.push(
      JSON.stringify({
        type: 'Feature',
        tippecanoe: { layer: 'routes', minzoom: MIN_ZOOM[mode] ?? 5 },
        properties: {
          feed: id,
          rid,
          agency: tags.operator || tags.network || 'OpenStreetMap',
          short: tags.ref ?? '',
          long: tags.name ?? (tags.from && tags.to ? `${tags.from} – ${tags.to}` : ''),
          color: colorOf(tags.colour, PALETTE[Number(rid) % PALETTE.length]),
          mode,
          source: 'osm',
        },
        geometry: { type: 'MultiLineString', coordinates: geom },
      }),
    );
  }
  rmSync(routesPbf, { force: true });
  rmSync(ways, { force: true });
  if (!routes) throw new Error('no transit routes found');
  writeFileSync(join(CACHE, `${id}.ndjson`), out.join('\n') + '\n');

  // Count it in the globe's counts, like a schedule feed. Its own file, so a schedule
  // run going at the same time can't overwrite it.
  const reportFile = join(TMP, 'report-osm.json');
  const report = existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, 'utf8')) : {};
  report[id] = { id, ok: true, provider: 'OpenStreetMap', state: path, country, source: `https://download.geofabrik.de/${path}-latest.osm.pbf`, routes, lines: routes, stops: 0, ms: Date.now() - started };
  writeFileSync(reportFile, JSON.stringify(report, null, 1));
  console.log(`${id}: ${routes} routes (${Object.entries(modes).map(([m, n]) => `${n} ${m}`).join(', ')}) in ${Math.round((Date.now() - started) / 1000)}s`);
}

/** One relation line of osmium's OPL output -> its id, tags and member way ids. */
export function parseRelation(line: string): { id: string; tags: Record<string, string>; ways: string[] } | null {
  if (!line.startsWith('r')) return null;
  const fields = line.split(' ');
  const id = fields[0].slice(1);
  if (!/^\d+$/.test(id)) return null;
  const tags = tagsOf(fields.find((f) => f.startsWith('T'))?.slice(1) ?? '');
  const ways = (fields.find((f) => f.startsWith('M'))?.slice(1) ?? '')
    .split(',')
    .filter((m) => m.startsWith('w'))
    .map((m) => (m.includes('@') ? m.slice(0, m.indexOf('@')) : m));
  return { id, tags, ways };
}

// Run only when started directly, not when the tests import the parsers.
if (import.meta.main) {
  const regions = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!regions.length) {
    console.error('Usage: node scripts/build-osm.ts <geofabrik path>:<country code> ...');
    process.exit(1);
  }
  let failed = 0;
  for (const r of regions) {
    const [path, country] = r.split(':');
    try {
      await buildRegion(path, (country ?? '').toUpperCase());
    } catch (err) {
      failed++;
      console.log(`::warning title=OpenStreetMap region failed::${path}: ${(err as Error).message}`);
    }
  }
  if (failed === regions.length) process.exit(1);
}

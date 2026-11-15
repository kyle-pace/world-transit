/*
  Which country a point is in, offline: world-atlas's 1:50m country borders (already a
  dev dependency) and a point-in-polygon test. Used for feeds whose catalog doesn't say
  (Transitland Atlas), so the globe can still count countries.

  Returns an ISO 3166 alpha-2 code ('US'), or '' at sea or where a name doesn't match.
  world-atlas names countries in English; Intl.DisplayNames gives English names for
  codes, and the two lists are matched by name (with a few known differences).
*/
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { feature } from 'topojson-client';

type Ring = number[][];
interface Country {
  code: string;
  bbox: [number, number, number, number];
  polygons: Ring[][];
}

// world-atlas name -> the name Intl uses, where they differ.
const ALIASES: Record<string, string> = {
  'United States of America': 'United States',
  'Dem. Rep. Congo': 'Congo - Kinshasa',
  Congo: 'Congo - Brazzaville',
  'Central African Rep.': 'Central African Republic',
  "Côte d'Ivoire": 'Côte d’Ivoire',
  'Dominican Rep.': 'Dominican Republic',
  'Bosnia and Herz.': 'Bosnia & Herzegovina',
  'Czechia': 'Czechia',
  'S. Sudan': 'South Sudan',
  'Eq. Guinea': 'Equatorial Guinea',
  'Myanmar': 'Myanmar (Burma)',
  'Macedonia': 'North Macedonia',
  'North Macedonia': 'North Macedonia',
  'eSwatini': 'Eswatini',
  'Solomon Is.': 'Solomon Islands',
  'Falkland Is.': 'Falkland Islands',
  'Faeroe Is.': 'Faroe Islands',
  'Marshall Is.': 'Marshall Islands',
  'Cayman Is.': 'Cayman Islands',
  'Turks and Caicos Is.': 'Turks & Caicos Islands',
  'Antigua and Barb.': 'Antigua & Barbuda',
  'St. Kitts and Nevis': 'St. Kitts & Nevis',
  'St. Vin. and Gren.': 'St. Vincent & Grenadines',
  'Trinidad and Tobago': 'Trinidad & Tobago',
  'São Tomé and Principe': 'São Tomé & Príncipe',
  'Hong Kong': 'Hong Kong SAR China',
  Macao: 'Macao SAR China',
  Palestine: 'Palestinian Territories',
  'W. Sahara': 'Western Sahara',
  'Fr. Polynesia': 'French Polynesia',
  'N. Mariana Is.': 'Northern Mariana Islands',
  'U.S. Virgin Is.': 'U.S. Virgin Islands',
  'British Virgin Is.': 'British Virgin Islands',
  'Puerto Rico': 'Puerto Rico',
  Kosovo: 'Kosovo',
  Turkey: 'Türkiye',
  Vatican: 'Vatican City',
  'Saint Helena': 'St. Helena',
  'Saint Lucia': 'St. Lucia',
  'Cabo Verde': 'Cape Verde',
  Åland: 'Åland Islands',
  'St-Martin': 'St. Martin',
  'St-Barthélemy': 'St. Barthélemy',
  'Cook Is.': 'Cook Islands',
  'Wallis and Futuna Is.': 'Wallis & Futuna',
  'St. Pierre and Miquelon': 'St. Pierre & Miquelon',
  'Pitcairn Is.': 'Pitcairn Islands',
  'N. Cyprus': 'Cyprus',
  Somaliland: 'Somalia',
};

// Codes no longer in use that Intl still names (East Germany, Zaire, Yugoslavia…).
const RETIRED = new Set(['DD', 'FX', 'ZR', 'YU', 'CS', 'BU', 'TP', 'SU', 'NT', 'AN', 'DY', 'HV', 'NH', 'RH', 'VD', 'YD', 'BQ', 'CT', 'JT', 'MI', 'NQ', 'PC', 'PU', 'PZ', 'WK', 'AQ']);

let countries: Country[] | null = null;

function load(): Country[] {
  const require = createRequire(import.meta.url);
  const topo = JSON.parse(readFileSync(require.resolve('world-atlas/countries-50m.json'), 'utf8'));
  const names = new Intl.DisplayNames(['en'], { type: 'region' });
  const byName = new Map<string, string>();
  for (let a = 65; a <= 90; a++)
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      try {
        const name = names.of(code);
        // First code wins: retired codes (FX, ZR) share names with current ones (FR, CD).
        if (name && name !== code && !byName.has(name) && !RETIRED.has(code)) byName.set(name, code);
      } catch {
        // not a region code
      }
    }
  const out: Country[] = [];
  const fc = feature(topo, topo.objects.countries) as unknown as GeoJSON.FeatureCollection;
  for (const f of fc.features) {
    const name = String(f.properties?.name ?? '');
    const code = byName.get(ALIASES[name] ?? name) ?? byName.get(name);
    if (!code || !f.geometry) continue;
    const polygons = f.geometry.type === 'Polygon' ? [f.geometry.coordinates as Ring[]] : f.geometry.type === 'MultiPolygon' ? (f.geometry.coordinates as Ring[][]) : [];
    let [w, s, e, n] = [180, 90, -180, -90];
    for (const poly of polygons)
      for (const [x, y] of poly[0]) {
        w = Math.min(w, x);
        e = Math.max(e, x);
        s = Math.min(s, y);
        n = Math.max(n, y);
      }
    out.push({ code, bbox: [w, s, e, n], polygons });
  }
  return out;
}

function inRing(x: number, y: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Distance in degrees from a point to a ring's nearest vertex (rough, for coastlines). */
function nearRing(x: number, y: number, ring: Ring): number {
  let best = Infinity;
  for (const [rx, ry] of ring) best = Math.min(best, Math.hypot(rx - x, ry - y));
  return best;
}

export function countryAt(lon: number, lat: number): string {
  countries ??= load();
  for (const c of countries) {
    const [w, s, e, n] = c.bbox;
    if (lon < w || lon > e || lat < s || lat > n) continue;
    for (const poly of c.polygons) if (inRing(lon, lat, poly[0]) && !poly.slice(1).some((hole) => inRing(lon, lat, hole))) return c.code;
  }
  // Coarse coastlines leave harbors and islands just outside: take the nearest country
  // within about 30 km.
  let best = 0.3;
  let code = '';
  for (const c of countries) {
    const [w, s, e, n] = c.bbox;
    if (lon < w - best || lon > e + best || lat < s - best || lat > n + best) continue;
    for (const poly of c.polygons) {
      const d = nearRing(lon, lat, poly[0]);
      if (d < best) {
        best = d;
        code = c.code;
      }
    }
  }
  return code;
}

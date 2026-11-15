/*
  The agencies directory (/world-transit/agencies/), read at build time from the same
  files the map uses: the search index (every agency, where it runs, how many routes, its
  country) and the live route lookups (which agencies have vehicles moving on the map).
*/
import agenciesIndex from '../../public/world-transit/search-agencies.json';

/** [name, west, south, east, north, routes, country, modes] */
type AgencyRow = [string, number, number, number, number, number, string, string];

export interface Agency {
  name: string;
  routes: number;
  modes: string[];
  live: boolean;
}
export interface Country {
  code: string; // lowercase ISO code, or "elsewhere"
  name: string;
  agencies: Agency[];
  routes: number;
  live: number;
}

const MODE_WORDS: Record<string, string> = { rail: 'trains', tram: 'trams', ferry: 'ferries', bus: 'buses', other: 'other' };
export const modeWords = (modes: string[]) => modes.map((m) => MODE_WORDS[m] ?? m).join(', ');

// Agencies with live vehicles: every agency named in a live feed's route lookup.
const lookups = import.meta.glob<Record<string, [string, string, string, string, string]>>('../../public/world-transit/routes/*.json', { eager: true, import: 'default' });
const liveAgencies = new Set<string>();
for (const lookup of Object.values(lookups)) for (const row of Object.values(lookup)) liveAgencies.add(row[4]);

const names = new Intl.DisplayNames(['en'], { type: 'region' });
const countryName = (code: string) => {
  try {
    return names.of(code.toUpperCase()) ?? code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
};

const byCountry = new Map<string, Agency[]>();
for (const [name, , , , , routes, cc, modes] of agenciesIndex as AgencyRow[]) {
  const code = cc ? cc.toLowerCase() : 'elsewhere';
  const order = ['rail', 'tram', 'ferry', 'bus', 'other'];
  const agency: Agency = { name, routes, modes: modes.split(',').filter(Boolean).sort((a, b) => order.indexOf(a) - order.indexOf(b)), live: liveAgencies.has(name) };
  byCountry.set(code, [...(byCountry.get(code) ?? []), agency]);
}

export const countries: Country[] = [...byCountry]
  .map(([code, agencies]) => ({
    code,
    name: code === 'elsewhere' ? 'Elsewhere (at sea or across borders)' : countryName(code),
    agencies: agencies.sort((a, b) => b.routes - a.routes || a.name.localeCompare(b.name)),
    routes: agencies.reduce((sum, a) => sum + a.routes, 0),
    live: agencies.filter((a) => a.live).length,
  }))
  .sort((a, b) => (a.code === 'elsewhere' ? 1 : b.code === 'elsewhere' ? -1 : a.name.localeCompare(b.name, 'en')));

/** The map, focused on one agency's routes. */
export const mapLink = (name: string) => `/world-transit/?agency=${encodeURIComponent(name)}`;

/*
  Search on the globe (/transit/globe/): one box for places and agencies.

  - Empty and focused: "Places to explore", a short list by region.
  - Typing: Places first (with their state or province, so the two Portlands differ), then
    "Transit in <the top place>", the agencies whose area covers it, biggest first, then
    other agencies whose name matches.
  - Picking a place flies there; picking an agency fits the map to where it runs and
    highlights its routes.

  The indexes (public/transit/globe/search-places.json and search-agencies.json, written
  by scripts/build-globe.ts) load the first time the box gets focus. Matching ignores case
  and accents ("montreal" finds Montréal), and every word typed has to appear.

  It's a combobox like the live map's: arrow keys move through the options, Enter picks,
  Escape closes, and the highlighted option is announced (aria-activedescendant). Group
  names are part of the list (role="group" with a label), so a screen reader hears
  "Transit in Portland" before TriMet.
*/
import type { Map as MapLibreMap } from 'maplibre-gl';
import { ICONS } from './transit-icons';

/** [name, ascii name, country, latitude, longitude, population, state or province] */
type PlaceRow = [string, string, string, number, number, number, string?];
/** [name, west, south, east, north, routes, country, modes] */
type AgencyRow = [string, number, number, number, number, number, string, string];

interface Option {
  kind: 'place' | 'agency';
  label: string;
  detail: string;
  go: () => void;
}
interface Group {
  label: string;
  options: Option[];
}

// Shown before anything is typed: [label, country, lon, lat, zoom] by region.
const EXPLORE: [string, [string, string, number, number, number][]][] = [
  ['North America', [['New York', 'United States', -73.95, 40.72, 10], ['Toronto', 'Canada', -79.38, 43.68, 10], ['Mexico City', 'Mexico', -99.13, 19.43, 10], ['Puget Sound', 'United States', -122.33, 47.6, 9]]],
  ['Europe', [['London', 'United Kingdom', -0.12, 51.5, 10], ['Paris', 'France', 2.35, 48.86, 10.5], ['Berlin', 'Germany', 13.4, 52.52, 10], ['Helsinki', 'Finland', 24.94, 60.19, 10.5]]],
  ['Asia and the Pacific', [['Tokyo', 'Japan', 139.75, 35.68, 10], ['Seoul', 'South Korea', 126.98, 37.55, 10], ['Shanghai', 'China', 121.47, 31.23, 10], ['Sydney', 'Australia', 151.2, -33.87, 10]]],
  ['South America and Africa', [['São Paulo', 'Brazil', -46.63, -23.55, 10], ['Buenos Aires', 'Argentina', -58.42, -34.6, 10], ['Cairo', 'Egypt', 31.24, 30.04, 10.5], ['Johannesburg', 'South Africa', 28.05, -26.2, 10]]],
];

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

const PIN = 'M12 2a7 7 0 0 1 7 7c0 5.25-7 13-7 13S5 14.25 5 9a7 7 0 0 1 7-7Zm0 4.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z';

export function globeSearch(
  root: HTMLElement,
  map: MapLibreMap,
  reducedMotion: () => boolean,
  onAgency: (name: string) => void = () => {},
  homeZoom: () => number = () => 2.6,
) {
  const input = root.querySelector<HTMLInputElement>('[data-search]');
  const list = root.querySelector<HTMLElement>('[data-results]');
  if (!input || !list) return;

  const countryName = (() => {
    const names = new Intl.DisplayNames(['en'], { type: 'region' });
    return (code: string) => {
      try {
        return code ? (names.of(code) ?? code) : '';
      } catch {
        return code;
      }
    };
  })();
  const n = (x: number) => x.toLocaleString('en-US');

  const fly = (center: [number, number], zoom: number) => {
    const target = { center, zoom: zoom || homeZoom(), pitch: 0, bearing: 0 };
    if (reducedMotion()) map.jumpTo(target);
    else map.flyTo({ ...target, duration: 2500, essential: false });
  };

  interface Place {
    name: string;
    words: string;
    detail: string;
    lon: number;
    lat: number;
    pop: number;
  }
  interface Agency {
    name: string;
    words: string;
    detail: string;
    box: [number, number, number, number];
    routes: number;
  }
  let places: Place[] = [];
  let agencies: Agency[] = [];
  let loading: Promise<void> | null = null;
  const load = () =>
    (loading ??= Promise.all([
      fetch('/transit/globe/search-places.json').then((r) => r.json() as Promise<PlaceRow[]>),
      fetch('/transit/globe/search-agencies.json').then((r) => r.json() as Promise<AgencyRow[]>),
    ])
      .then(([p, a]) => {
        places = p.map(([name, ascii, cc, lat, lon, pop, region]) => {
          const country = countryName(cc);
          return { name, words: fold(`${name} ${ascii} ${region ?? ''} ${country}`), detail: [region, country].filter(Boolean).join(', '), lon, lat, pop };
        });
        agencies = a.map(([name, w, s, e, nn, routes, cc]) => {
          const country = countryName(cc);
          return { name, words: fold(`${name} ${country}`), detail: [country, `${n(routes)} ${routes === 1 ? 'route' : 'routes'}`].filter(Boolean).join(', '), box: [w, s, e, nn], routes };
        });
        if (document.activeElement === input) run();
      })
      .catch(() => {
        loading = null; // try again on the next focus
      }));

  const placeOption = (p: Place): Option => ({
    kind: 'place',
    label: p.name,
    detail: p.detail,
    // Bigger cities need a wider view to take in their network.
    go: () => fly([p.lon, p.lat], p.pop > 5_000_000 ? 9.5 : p.pop > 1_000_000 ? 10.5 : 11.5),
  });
  const agencyOption = (a: Agency): Option => ({
    kind: 'agency',
    label: a.name,
    detail: a.detail,
    go: () => {
      onAgency(a.name);
      const [w, s, e, nn] = a.box;
      map.fitBounds(
        [
          [w, s],
          [e, nn],
        ],
        { padding: 40, maxZoom: 13, duration: reducedMotion() ? 0 : 2500 },
      );
    },
  });

  let groups: Group[] = [];
  let flat: Option[] = [];
  let active = -1;

  function icon(kind: Option['kind']) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('result-icon');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', kind === 'place' ? PIN : ICONS.bus);
    path.setAttribute('fill-rule', 'evenodd');
    svg.append(path);
    return svg;
  }

  function render() {
    flat = groups.flatMap((g) => g.options);
    let i = 0;
    list!.replaceChildren(
      ...groups.map((g, gi) => {
        const group = document.createElement('li');
        group.setAttribute('role', 'group');
        group.setAttribute('aria-labelledby', `globe-group-${gi}`);
        const heading = document.createElement('span');
        heading.id = `globe-group-${gi}`;
        heading.className = 'result-group';
        heading.textContent = g.label;
        const inner = document.createElement('ul');
        inner.setAttribute('role', 'presentation');
        for (const option of g.options) {
          const n = i++;
          const li = document.createElement('li');
          li.id = `globe-result-${n}`;
          li.className = n === active ? 'active' : '';
          li.setAttribute('role', 'option');
          li.setAttribute('aria-selected', String(n === active));
          const text = document.createElement('span');
          text.className = 'result-text';
          const label = document.createElement('span');
          label.className = 'result-label';
          label.textContent = option.label;
          const detail = document.createElement('span');
          detail.className = 'result-detail';
          detail.textContent = option.detail;
          text.append(label, detail);
          li.append(icon(option.kind), text);
          li.addEventListener('mousedown', (e) => {
            e.preventDefault();
            choose(option);
          });
          inner.append(li);
        }
        group.append(heading, inner);
        return group;
      }),
    );
    const open = flat.length > 0;
    list!.hidden = !open;
    input!.setAttribute('aria-expanded', String(open));
    if (active >= 0) {
      input!.setAttribute('aria-activedescendant', `globe-result-${active}`);
      document.getElementById(`globe-result-${active}`)?.scrollIntoView({ block: 'nearest' });
    } else input!.removeAttribute('aria-activedescendant');
  }

  function explore(): Group[] {
    return [
      { label: 'Places to explore', options: [{ kind: 'place', label: 'The whole world', detail: 'Back to the starting view', go: () => fly([-98, 39], 0) }] },
      ...EXPLORE.map(([region, list]) => ({
        label: region,
        options: list.map(([label, country, lon, lat, zoom]) => ({ kind: 'place' as const, label, detail: country, go: () => fly([lon, lat], zoom) })),
      })),
    ];
  }

  /** Lower is better: exact name, then name starts with it, then a word does. Size breaks ties. */
  function score(name: string, words: string, q: string, size: number) {
    const f = fold(name);
    const base = f === q ? 0 : f.startsWith(q) ? 1 : ` ${words}`.includes(` ${q.split(/\s+/)[0]}`) ? 2 : 3;
    return base - Math.log10(size + 1) / 10;
  }

  function run() {
    const q = fold(input!.value.trim());
    active = -1;
    if (!q) {
      groups = explore();
      return render();
    }
    const terms = q.split(/\s+/);
    const has = (words: string) => terms.every((t) => words.includes(t));

    const matchedPlaces = places
      .filter((p) => has(p.words))
      .map((p) => [score(p.name, p.words, q, p.pop), p] as const)
      .sort((a, b) => a[0] - b[0])
      .slice(0, 4)
      .map(([, p]) => p);

    // Agencies that run in the top place, biggest first.
    const top = matchedPlaces[0];
    const local = top
      ? agencies
          .filter(({ box: [w, s, e, n] }) => top.lon >= w && top.lon <= e && top.lat >= s && top.lat <= n)
          // A national rail operator covers every city; keep the ones that are about here.
          .filter(({ box: [w, s, e, n] }) => (e - w) * (n - s) < 40)
          .sort((a, b) => b.routes - a.routes)
          .slice(0, 5)
      : [];
    const localNames = new Set(local.map((a) => a.name));
    const named = agencies
      .filter((a) => !localNames.has(a.name) && has(a.words))
      .map((a) => [score(a.name, a.words, q, a.routes), a] as const)
      .sort((a, b) => a[0] - b[0])
      .slice(0, 4)
      .map(([, a]) => a);

    groups = [
      { label: 'Places', options: matchedPlaces.map(placeOption) },
      { label: top ? `Transit in ${top.name}` : 'Transit', options: local.map(agencyOption) },
      { label: 'Agencies', options: named.map(agencyOption) },
    ].filter((g) => g.options.length);
    if (!groups.length && places.length) groups = [{ label: `Nothing found for “${input!.value.trim()}”`, options: [] }];
    render();
    // An empty result still says so: the list shows the message even with no options.
    if (!flat.length && groups.length) {
      list!.hidden = false;
    }
  }

  function choose(option: Option) {
    input!.value = '';
    groups = [];
    render();
    input!.blur();
    option.go();
  }

  input.addEventListener('focus', () => {
    void load();
    run();
  });
  input.addEventListener('input', () => {
    if (!places.length) void load();
    run();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!flat.length) return;
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + flat.length) % flat.length;
      render();
    } else if (e.key === 'Enter') {
      const option = flat[active >= 0 ? active : 0];
      if (option) {
        e.preventDefault();
        choose(option);
      }
    } else if (e.key === 'Escape') {
      groups = [];
      render();
    }
  });
  input.addEventListener('blur', () => {
    groups = [];
    render();
  });
}

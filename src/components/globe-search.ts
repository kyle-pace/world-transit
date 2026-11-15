/*
  Search on the globe (/transit/globe/): places and agencies, in one box.

  The two indexes (public/transit/globe/search-places.json and search-agencies.json,
  written by scripts/build-globe.ts) are fetched the first time the box gets focus, so the
  page itself stays light. Matching ignores case and accents ("montreal" finds Montréal),
  and every word typed has to appear. Picking a place flies there; picking an agency fits
  the map to where it runs.

  The box is a combobox, like the live map's: arrow keys move through the results, Enter
  picks, Escape closes, and the highlighted result is announced (aria-activedescendant).
*/
import type { Map as MapLibreMap } from 'maplibre-gl';

/** [name, ascii name, country, latitude, longitude, population] */
type PlaceRow = [string, string, string, number, number, number];
/** [name, west, south, east, north, routes, country, modes] */
type AgencyRow = [string, number, number, number, number, number, string, string];

interface Item {
  kind: 'place' | 'agency';
  label: string;
  detail: string;
  /** Lowercase, accent-free text to match against. */
  words: string;
  /** Bigger first among equally good matches: population or route count. */
  size: number;
  go: () => void;
}

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

export function globeSearch(root: HTMLElement, map: MapLibreMap, reducedMotion: () => boolean) {
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
    const target = { center, zoom, pitch: 0, bearing: 0 };
    if (reducedMotion()) map.jumpTo(target);
    else map.flyTo({ ...target, duration: 2500, essential: false });
  };

  let items: Item[] = [];
  let loading: Promise<void> | null = null;
  const load = () =>
    (loading ??= Promise.all([
      fetch('/transit/globe/search-places.json').then((r) => r.json() as Promise<PlaceRow[]>),
      fetch('/transit/globe/search-agencies.json').then((r) => r.json() as Promise<AgencyRow[]>),
    ])
      .then(([places, agencies]) => {
        const out: Item[] = [];
        for (const [name, ascii, cc, lat, lon, pop] of places) {
          const country = countryName(cc);
          out.push({
            kind: 'place',
            label: name,
            detail: country,
            words: fold(`${name} ${ascii} ${country}`),
            size: pop,
            // Bigger cities need a wider view to take in their network.
            go: () => fly([lon, lat], pop > 5_000_000 ? 9.5 : pop > 1_000_000 ? 10.5 : 11.5),
          });
        }
        for (const [name, w, s, e, nn, routes, cc] of agencies) {
          const country = countryName(cc);
          out.push({
            kind: 'agency',
            label: name,
            detail: [country, `${n(routes)} ${routes === 1 ? 'route' : 'routes'}`].filter(Boolean).join(', '),
            words: fold(`${name} ${country}`),
            size: routes,
            go: () =>
              map.fitBounds(
                [
                  [w, s],
                  [e, nn],
                ],
                { padding: 40, maxZoom: 13, duration: reducedMotion() ? 0 : 2500 },
              ),
          });
        }
        items = out;
        if (input.value.trim()) run();
      })
      .catch(() => {
        loading = null; // try again on the next focus
      }));

  let results: Item[] = [];
  let active = -1;

  function render() {
    list!.replaceChildren(
      ...results.map((item, i) => {
        const li = document.createElement('li');
        li.id = `globe-result-${i}`;
        li.className = i === active ? 'active' : '';
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', String(i === active));
        const label = document.createElement('span');
        label.className = 'result-label';
        label.textContent = item.label;
        const detail = document.createElement('span');
        detail.className = 'result-detail';
        // Say what kind of result it is in words, not only by position or styling.
        detail.textContent = [item.kind === 'place' ? 'Place' : 'Agency', item.detail].filter(Boolean).join(', ');
        li.append(label, detail);
        li.addEventListener('mousedown', (e) => {
          e.preventDefault();
          choose(item);
        });
        return li;
      }),
    );
    list!.hidden = !results.length;
    input!.setAttribute('aria-expanded', String(results.length > 0));
    if (active >= 0) input!.setAttribute('aria-activedescendant', `globe-result-${active}`);
    else input!.removeAttribute('aria-activedescendant');
  }

  function run() {
    const q = fold(input!.value.trim());
    active = -1;
    if (!q) {
      results = [];
      return render();
    }
    const terms = q.split(/\s+/);
    const scored: [number, Item][] = [];
    for (const item of items) {
      if (!terms.every((t) => item.words.includes(t))) continue;
      const name = fold(item.label);
      // Lower is better: exact name, then name starts with it, then a word starts with it.
      let score = name === q ? 0 : name.startsWith(q) ? 1 : item.words.includes(` ${terms[0]}`) || item.words.startsWith(terms[0]) ? 2 : 3;
      score -= Math.log10(item.size + 1) / 10; // big cities and big agencies first among equals
      scored.push([score, item]);
    }
    scored.sort((a, b) => a[0] - b[0]);
    results = scored.slice(0, 8).map(([, item]) => item);
    render();
  }

  function choose(item: Item) {
    input!.value = '';
    results = [];
    render();
    input!.blur();
    item.go();
  }

  input.addEventListener('focus', () => void load());
  input.addEventListener('input', () => {
    if (!items.length) void load();
    run();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!results.length) return;
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      render();
    } else if (e.key === 'Enter') {
      const item = results[active >= 0 ? active : 0];
      if (item) {
        e.preventDefault();
        choose(item);
      }
    } else if (e.key === 'Escape') {
      results = [];
      render();
    }
  });
  input.addEventListener('blur', () => {
    results = [];
    render();
  });
}

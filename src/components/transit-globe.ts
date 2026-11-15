/*
  The transit globe at /world-transit/: every route and stop in one country's open
  schedules, on a globe you can spin and zoom into a single street.

  Data: public/world-transit/<country>.pmtiles, built by scripts/build-globe.ts. PMTiles is
  one file holding every vector tile; the `pmtiles` library reads just the tiles on screen
  from it with HTTP range requests, so no tile server is needed.

  Basemap: OpenFreeMap (same as the Washington map), retinted to the page's Shore and Sound.
*/
import maplibregl, { type Map as MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Protocol } from 'pmtiles';
import { liveVehicles, type LiveFeedRow } from './globe-vehicles';
import { globeSearch } from './globe-search';
import { track } from 'kp-design/analytics';

const EXPERIMENT = 'world-transit';

type Mode = 'bus' | 'rail' | 'tram' | 'ferry' | 'other';

const STYLES = {
  light: 'https://tiles.openfreemap.org/styles/positron',
  dark: 'https://tiles.openfreemap.org/styles/dark',
};
// Keep in step with BASEMAP in transit-map.ts and src/styles/theme.css.
const BASEMAP = {
  light: { land: '#eceee8', water: '#b3cad2', green: null, space: '#16242a', halo: '#ffffff' },
  // A touch lighter than the page's own darks, so the planet reads against space.
  dark: { land: '#232d31', water: '#1f4150', green: '#283236', space: '#040708', halo: '#121719' },
};
const MODE_NAMES: Record<Mode, string> = { bus: 'Bus', rail: 'Train', tram: 'Light rail or streetcar', ferry: 'Ferry', other: 'Other' };
// Drawn bottom to top, so trains sit over the buses that feed them.
const MODE_ORDER: Mode[] = ['bus', 'other', 'ferry', 'tram', 'rail'];
// Buses reach full color at this zoom (street level); further out they're softened.
const BUS_COLOR_ZOOM = 13;
// How far a bus line's color is blended toward the land color further out (0 to 1).
// Less on the dark map: blending toward near-black dims a line much faster.
const BUS_SOFTEN = { light: 0.4, dark: 0.25 };
const RAIL_MODES: Mode[] = ['tram', 'rail'];

/**
 * A route's own color blended toward the land: MapLibre can't desaturate, but it can do
 * arithmetic on a color's channels, so every bus keeps its hue, just quieter.
 */
function softened(land: string, amount: number): maplibregl.ExpressionSpecification {
  const n = parseInt(land.slice(1), 16);
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  // A route with no usable color counts as gray, rather than failing the whole expression.
  const color: maplibregl.ExpressionSpecification = ['to-rgba', ['to-color', ['get', 'color'], '#868e96']];
  const channel = (i: number): maplibregl.ExpressionSpecification => ['+', ['*', ['at', i, color], 1 - amount], rgb[i] * amount];
  return ['rgba', channel(0), channel(1), channel(2), 1];
}
/** Buses: softened further out, their own color at street level. */
const busColor = (theme: 'light' | 'dark'): maplibregl.ExpressionSpecification => ['interpolate', ['linear'], ['zoom'], BUS_COLOR_ZOOM - 2, softened(BASEMAP[theme].land, BUS_SOFTEN[theme]), BUS_COLOR_ZOOM, ['get', 'color']];

const theme = (): 'light' | 'dark' => {
  const set = document.documentElement.dataset.theme;
  if (set === 'light' || set === 'dark') return set;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};
const reducedMotion = () =>
  document.documentElement.dataset.motion === 'reduce' ||
  (document.documentElement.dataset.motion !== 'full' && matchMedia('(prefers-reduced-motion: reduce)').matches);

export function startGlobe(root: HTMLElement) {
  const container = root.querySelector<HTMLElement>('[data-map]')!;
  const country = root.dataset.country ?? 'us';
  const tiles = `pmtiles://${location.origin}/world-transit/${country}.pmtiles`;
  const modeInputs = [...root.querySelectorAll<HTMLInputElement>('[data-mode]')];
  const status = root.querySelector<HTMLElement>('[data-status]');
  const liveStatus = root.querySelector<HTMLElement>('[data-live-status]');
  const liveInput = root.querySelector<HTMLInputElement>('[data-live]');
  const liveOnlyInput = root.querySelector<HTMLInputElement>('[data-live-only]');
  // The live feeds' list (ids and areas) loads after the map, so the page stays light.
  const liveFeeds: LiveFeedRow[] = [];

  const protocol = new Protocol();
  maplibregl.addProtocol('pmtiles', protocol.tile);

  let currentTheme = theme();
  // Far enough out to see the curve of the Earth: a narrow phone needs to start further back.
  const homeZoom = () => (container.clientWidth < 600 ? 1.4 : 2.6);
  const map: MapLibreMap = new maplibregl.Map({
    container,
    style: STYLES[currentTheme],
    // Start over North America.
    center: [-98, 39],
    zoom: homeZoom(),
    attributionControl: false,
    cooperativeGestures: matchMedia('(pointer: coarse)').matches,
    maxPitch: 60,
  });
  map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: 'Routes from agency schedules (GTFS) via the Mobility Database, and OpenStreetMap' }), 'bottom-left');
  // MapLibre opens the compact credits at first; on phones fold them to the (i) button.
  map.once('load', () => {
    if (matchMedia('(max-width: 47.99rem)').matches) container.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
  const live = liveVehicles(map, liveFeeds, (text) => {
    if (liveStatus && liveStatus.textContent !== text) liveStatus.textContent = text;
  });
  map.once('load', async () => {
    try {
      liveFeeds.push(...((await fetch('/world-transit/live-feeds.json').then((r) => r.json())) as LiveFeedRow[]));
    } catch {
      // No live list: routes still show; vehicles just don't.
    }
    liveSchedules = [...new Set(liveFeeds.map((f) => f[2]))];
    // Links that open on a view: ?at=lon,lat,zoom (the old /transit/ map redirects here,
    // centered on Puget Sound).
    const at = new URLSearchParams(location.search).get('at')?.split(',').map(Number);
    if (at && at.length === 3 && at.every(Number.isFinite)) map.jumpTo({ center: [at[0], at[1]], zoom: at[2] });
    // Links from the agencies directory: /world-transit/?agency=<name> opens focused on it.
    const wanted = new URLSearchParams(location.search).get('agency');
    if (wanted) {
      type Row = [string, number, number, number, number, number, string, string];
      const rows = (await fetch('/world-transit/search-agencies.json').then((r) => r.json()).catch(() => [])) as Row[];
      const row = rows.find((r) => r[0] === wanted);
      if (row) {
        setFocus({ agency: row[0] });
        map.fitBounds(
          [
            [row[1], row[2]],
            [row[3], row[4]],
          ],
          { padding: 40, maxZoom: 13, duration: 0 },
        );
      }
    }
    drawHotspots();
    applyFilters();
    live.start();
  });
  liveInput?.addEventListener('change', () => live.setVisible(liveInput.checked));

  // ---------- Only live places ----------
  // Schedules that have a live feed: their routes stay when "Only live places" is on.
  let liveSchedules: string[] = [];
  const liveOnly = () => Boolean(liveOnlyInput?.checked);

  /** One dot per live system from orbit, sized by its vehicles at the last check. */
  function hotspotData(): GeoJSON.FeatureCollection<GeoJSON.Point> {
    return {
      type: 'FeatureCollection',
      features: liveFeeds.map(([id, name, schedule, [w, s, e, n], vehicles]) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [(w + e) / 2, (s + n) / 2] },
        properties: { id, name, schedule, vehicles: vehicles ?? 0, w, s, e, n },
      })),
    };
  }
  function drawHotspots() {
    map.getSource<maplibregl.GeoJSONSource>('hotspots')?.setData(hotspotData());
  }
  liveOnlyInput?.addEventListener('change', () => {
    track('Changed Live Filter', { experiment: EXPERIMENT, live_only: liveOnly() });
    applyFilters();
    // Turning it on from far away: the dots are the point, so make sure they're in view.
    if (liveOnly() && map.getZoom() > 7 && !map.queryRenderedFeatures({ layers: ['vehicles'] }).length) live.start();
  });
  map.addControl(new maplibregl.FullscreenControl({ container: root.querySelector<HTMLElement>('[data-frame]')! }), 'top-right');

  function tintBasemap() {
    const t = BASEMAP[currentTheme];
    for (const layer of map.getStyle().layers ?? []) {
      if (layer.type === 'background') map.setPaintProperty(layer.id, 'background-color', t.land);
      else if (layer.type === 'fill' && /^water/.test(layer.id)) map.setPaintProperty(layer.id, 'fill-color', t.water);
      else if (layer.type === 'line' && /^waterway/.test(layer.id)) map.setPaintProperty(layer.id, 'line-color', t.water);
      else if (t.green && layer.type === 'fill' && /park|wood|grass/.test(layer.id)) map.setPaintProperty(layer.id, 'fill-color', t.green);
    }
  }

  const activeModes = () => {
    const on = modeInputs.filter((i) => i.checked).map((i) => i.value);
    return on.includes('bus') ? [...on, 'other'] : on;
  };

  function applyFilters() {
    const modes = activeModes();
    const only = liveOnly() && liveSchedules.length > 0;
    const inLive: maplibregl.FilterSpecification = ['in', ['get', 'feed'], ['literal', liveSchedules]];
    for (const mode of MODE_ORDER) {
      const id = `routes-${mode}`;
      if (!map.getLayer(id)) continue;
      map.setLayoutProperty(id, 'visibility', modes.includes(mode) ? 'visible' : 'none');
      const byMode: maplibregl.FilterSpecification = ['==', ['get', 'mode'], mode];
      map.setFilter(id, only ? ['all', byMode, inLive] : byMode);
      const casing = `casing-${mode}`;
      if (map.getLayer(casing)) {
        map.setLayoutProperty(casing, 'visibility', modes.includes(mode) ? 'visible' : 'none');
        map.setFilter(casing, only ? ['all', byMode, inLive] : byMode);
      }
    }
    if (map.getLayer('stops')) map.setFilter('stops', only ? inLive : null);
    if (map.getLayer('hotspots')) map.setLayoutProperty('hotspots', 'visibility', only ? 'visible' : 'none');
  }

  function addOverlay() {
    // The globe: MapLibre draws the same style on a sphere until about zoom 6, then eases
    // into the flat map, so city streets look the way they always do.
    map.setProjection({ type: 'globe' });
    const t = BASEMAP[currentTheme];
    // Space behind the planet: the container's background shows through.
    container.style.background = t.space;
    // No atmosphere: MapLibre lights it from a fixed sun, which left a bright crescent on
    // one edge. A crisp rim against space reads better, and the blue oceans give the shape.
    map.setSky({ 'sky-color': t.space, 'horizon-color': t.space, 'fog-color': t.space, 'sky-horizon-blend': 0, 'atmosphere-blend': 0 });
    tintBasemap();

    map.addSource('transit', { type: 'vector', url: tiles, attribution: '' });
    // Routes go above every basemap road and area, under the labels that come after them.
    // (The dark style has a label layer early on, below its roads; inserting before the
    // first label hid every bus under the road fills.)
    const styleLayers = map.getStyle().layers ?? [];
    let lastShape = -1;
    styleLayers.forEach((l, i) => {
      if (l.type === 'line' || l.type === 'fill' || l.type === 'fill-extrusion') lastShape = i;
    });
    const firstLabel = styleLayers.find((l, i) => i > lastShape && l.type === 'symbol')?.id;
    for (const mode of MODE_ORDER) {
      const heavy = mode === 'rail' || mode === 'tram' || mode === 'ferry';
      // A thin outline in the land color under trains and trams lifts them off the buses.
      if (RAIL_MODES.includes(mode))
        map.addLayer(
          {
            id: `casing-${mode}`,
            type: 'line',
            source: 'transit',
            'source-layer': 'routes',
            filter: ['==', ['get', 'mode'], mode],
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: {
              'line-color': t.land,
              'line-width': ['interpolate', ['linear'], ['zoom'], 2, 0, 7, 2.5, 8, 4, 14, 8],
              'line-opacity': 0.9,
            },
          },
          firstLabel,
        );
      map.addLayer(
        {
          id: `routes-${mode}`,
          type: 'line',
          source: 'transit',
          'source-layer': 'routes',
          filter: ['==', ['get', 'mode'], mode],
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: {
            // The hierarchy: trains, trams and ferries in full color at every zoom, outlined;
            // buses in their own colors softened toward the land until street level.
            'line-color': heavy ? ['get', 'color'] : busColor(currentTheme),
            // Hairlines from orbit, full strokes at street level.
            'line-width': heavy ? ['interpolate', ['linear'], ['zoom'], 2, 0.8, 8, 2, 14, 5] : ['interpolate', ['linear'], ['zoom'], 7, 0.4, 12, 0.9, 14, 3],
            'line-opacity': heavy ? 0.95 : ['interpolate', ['linear'], ['zoom'], 7, 0.6, BUS_COLOR_ZOOM, 0.9],
            ...(mode === 'ferry' ? { 'line-dasharray': [2, 1.5] } : {}),
          },
        },
        firstLabel,
      );
    }
    map.addLayer(
      {
        id: 'stops',
        type: 'circle',
        source: 'transit',
        'source-layer': 'stops',
        // Stops wait for street level, small, so they mark the lines instead of hiding them.
        minzoom: 13,
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 1.5, 16, 4],
          'circle-color': t.halo,
          'circle-stroke-color': currentTheme === 'dark' ? '#9badb3' : '#46545a',
          'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 13, 0.5, 16, 1],
        },
      },
      firstLabel,
    );
    // Live systems from orbit (shown with "Only live places"), fading out as vehicles take over.
    map.addSource('hotspots', { type: 'geojson', data: hotspotData() });
    map.addLayer({
      id: 'hotspots',
      type: 'circle',
      source: 'hotspots',
      maxzoom: 9,
      layout: { visibility: 'none' },
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['sqrt', ['get', 'vehicles']], 0, 3, 10, 7, 40, 16],
        'circle-color': ['case', ['>', ['get', 'vehicles'], 0], currentTheme === 'dark' ? '#6fd0ad' : '#0b5a47', 'rgba(0,0,0,0)'],
        'circle-stroke-color': currentTheme === 'dark' ? '#6fd0ad' : '#0b5a47',
        'circle-stroke-width': 1.5,
        'circle-opacity': ['interpolate', ['linear'], ['zoom'], 6, 0.75, 9, 0],
        'circle-stroke-opacity': ['interpolate', ['linear'], ['zoom'], 6, 1, 9, 0],
      },
    });
    // Vehicles on top of everything, ringed in the land color so they stand off the lines.
    live.addLayer(t.halo);
    applyFilters();
    applyFocus();
  }
  map.on('style.load', addOverlay);

  modeInputs.forEach((i) => i.addEventListener('change', applyFilters));

  // ---------- Focus: one route or one agency stands out, the rest fade ----------
  type Focus = { feed: string; rid: string } | { agency: string } | null;
  let focus: Focus = null;
  function applyFocus() {
    const match: maplibregl.ExpressionSpecification | null = !focus
      ? null
      : 'agency' in focus
        ? ['==', ['get', 'agency'], focus.agency]
        : ['all', ['==', ['get', 'feed'], focus.feed], ['==', ['to-string', ['get', 'rid']], focus.rid]];
    for (const mode of MODE_ORDER) {
      const id = `routes-${mode}`;
      if (!map.getLayer(id)) continue;
      const heavy = mode === 'rail' || mode === 'tram' || mode === 'ferry';
      const base = heavy ? 0.95 : (['interpolate', ['linear'], ['zoom'], 7, 0.6, BUS_COLOR_ZOOM, 0.9] as maplibregl.ExpressionSpecification);
      map.setPaintProperty(id, 'line-opacity', match ? ['case', match, 1, 0.12] : base);
      // A focused bus route shows its full color at any zoom.
      if (!heavy) map.setPaintProperty(id, 'line-color', match ? ['case', match, ['get', 'color'], softened(BASEMAP[currentTheme].land, BUS_SOFTEN[currentTheme])] : busColor(currentTheme));
      if (map.getLayer(`casing-${mode}`)) map.setPaintProperty(`casing-${mode}`, 'line-opacity', match ? ['case', match, 0.9, 0] : 0.9);
    }
  }
  const setFocus = (f: Focus) => {
    focus = f;
    applyFocus();
  };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && focus && !(e.target instanceof HTMLInputElement)) setFocus(null);
  });

  // A route's name and agency on click or tap.
  const routeLayers = MODE_ORDER.map((m) => `routes-${m}`);
  let popup: maplibregl.Popup | null = null;
  map.on('click', (e) => {
    const box: [maplibregl.PointLike, maplibregl.PointLike] = [
      [e.point.x - 6, e.point.y - 6],
      [e.point.x + 6, e.point.y + 6],
    ];
    const hits = map.queryRenderedFeatures(box, { layers: routeLayers.filter((l) => map.getLayer(l)) });
    popup?.remove();
    // A live system's dot: fly to where it runs.
    const spot = map.getLayer('hotspots') && liveOnly() ? map.queryRenderedFeatures(box, { layers: ['hotspots'] })[0] : undefined;
    if (spot) {
      const q = spot.properties as { w: number; s: number; e: number; n: number };
      map.fitBounds(
        [
          [q.w, q.s],
          [q.e, q.n],
        ],
        { padding: 40, maxZoom: 12, duration: reducedMotion() ? 0 : 2500 },
      );
      return;
    }
    // A vehicle wins over the lines under it.
    const vehiclePopup = live.popupAt(e);
    if (vehiclePopup) {
      popup = vehiclePopup;
      track('Tapped Vehicle', { experiment: EXPERIMENT });
      return;
    }
    if (!hits.length) {
      setFocus(null);
      return;
    }
    const first = hits[0].properties as { feed: string; rid: string | number; mode: string };
    setFocus({ feed: first.feed, rid: String(first.rid) });
    track('Tapped Route', { experiment: EXPERIMENT, mode: first.mode });
    const seen = new Set<string>();
    const list = document.createElement('ul');
    list.className = 'globe-hits';
    for (const f of hits) {
      const p = f.properties as { agency: string; short: string; long: string; color: string; mode: Mode };
      const key = `${p.agency}|${p.short}|${p.long}`;
      if (seen.has(key) || seen.size >= 6) continue;
      seen.add(key);
      const li = document.createElement('li');
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = p.color;
      const name = document.createElement('strong');
      name.textContent = [p.short, p.long].filter(Boolean).join(' ') || 'Unnamed route';
      const sub = document.createElement('span');
      // OpenStreetMap lines say so: they have no timetable behind them.
      const source = (f.properties as { source?: string }).source === 'osm' ? ' (from OpenStreetMap)' : '';
      sub.textContent = `${MODE_NAMES[p.mode] ?? 'Route'}, ${p.agency}${source}`;
      li.append(swatch, name, sub);
      list.append(li);
    }
    popup = new maplibregl.Popup({ maxWidth: '20rem' }).setLngLat(e.lngLat).setDOMContent(list).addTo(map);
    // Closing the popup with its × lets the whole network back in.
    popup.on('close', () => {
      if (focus && 'feed' in focus && focus.feed === first.feed) setFocus(null);
    });
  });
  for (const id of [...routeLayers, 'vehicles', 'hotspots']) {
    map.on('mouseenter', id, () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', id, () => (map.getCanvas().style.cursor = ''));
  }

  globeSearch(root, map, reducedMotion, (agency) => setFocus({ agency }), homeZoom);

  // Somewhere random: a dense transit city, never the same one twice in a row.
  type DenseRow = [name: string, region: string, country: string, lat: number, lon: number, routes: number];
  const randomButton = root.querySelector<HTMLButtonElement>('[data-random]');
  const randomWhere = root.querySelector<HTMLElement>('[data-random-where]');
  let dense: DenseRow[] = [];
  let lastRandom = -1;
  randomButton?.addEventListener('click', async () => {
    track('Tapped Somewhere Random', { experiment: EXPERIMENT });
    if (!dense.length) dense = await fetch('/world-transit/search-dense.json').then((r) => r.json()).catch(() => []);
    if (!dense.length) return;
    let i = Math.floor(Math.random() * dense.length);
    if (i === lastRandom) i = (i + 1) % dense.length;
    lastRandom = i;
    const [name, region, cc, lat, lon, routes] = dense[i];
    let country = cc;
    try {
      country = new Intl.DisplayNames(['en'], { type: 'region' }).of(cc) ?? cc;
    } catch {
      // keep the code
    }
    if (randomWhere) randomWhere.textContent = `${[name, region, country].filter(Boolean).join(', ')}. About ${routes.toLocaleString('en-US')} routes nearby.`;
    const target = { center: [lon, lat] as [number, number], zoom: 11, pitch: 0, bearing: 0 };
    if (reducedMotion()) map.jumpTo(target);
    else map.flyTo({ ...target, duration: 3000, essential: false });
  });

  map.on('error', (e) => {
    if (status && /pmtiles|transit/i.test(String(e.error?.message))) status.textContent = 'The routes didn’t load. Try reloading the page.';
  });

  // Follow the site's light/dark setting.
  const onTheme = () => {
    const next = theme();
    if (next === currentTheme) return;
    currentTheme = next;
    map.setStyle(STYLES[next]);
  };
  new MutationObserver(onTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', onTheme);
}

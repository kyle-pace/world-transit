/*
  The transit globe at /transit/globe/: every route and stop in one country's open
  schedules, on a globe you can spin and zoom into a single street.

  Data: public/transit/globe/<country>.pmtiles, built by scripts/build-globe.ts. PMTiles is
  one file holding every vector tile; the `pmtiles` library reads just the tiles on screen
  from it with HTTP range requests, so no tile server is needed.

  Basemap: OpenFreeMap (same as the Washington map), retinted to the page's Shore and Sound.
*/
import maplibregl, { type Map as MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Protocol } from 'pmtiles';
import { liveVehicles, type LiveFeedRow } from './globe-vehicles';
import { globeSearch } from './globe-search';

type Mode = 'bus' | 'rail' | 'tram' | 'ferry' | 'other';

const STYLES = {
  light: 'https://tiles.openfreemap.org/styles/positron',
  dark: 'https://tiles.openfreemap.org/styles/dark',
};
// Keep in step with BASEMAP in transit-map.ts and src/styles/theme.css.
const BASEMAP = {
  light: { land: '#eceee8', water: '#b3cad2', green: null, space: '#16242a', halo: '#ffffff', network: '#8d9a9f' },
  dark: { land: '#1b2326', water: '#1a3440', green: '#20292c', space: '#040708', halo: '#121719', network: '#56656b' },
};
const MODE_NAMES: Record<Mode, string> = { bus: 'Bus', rail: 'Train', tram: 'Light rail or streetcar', ferry: 'Ferry', other: 'Other' };
// Drawn bottom to top, so trains sit over the buses that feed them.
const MODE_ORDER: Mode[] = ['bus', 'other', 'ferry', 'tram', 'rail'];
// Buses take their own colors from this zoom (street level); before it they're one gray network.
const BUS_COLOR_ZOOM = 13;

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
  const tiles = `pmtiles://${location.origin}/transit/globe/${country}.pmtiles`;
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
      liveFeeds.push(...((await fetch('/transit/globe/live-feeds.json').then((r) => r.json())) as LiveFeedRow[]));
    } catch {
      // No live list: routes still show; vehicles just don't.
    }
    liveSchedules = [...new Set(liveFeeds.map((f) => f[2]))];
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
    }
    if (map.getLayer('stops')) map.setFilter('stops', only ? inLive : null);
    if (map.getLayer('hotspots')) map.setLayoutProperty('hotspots', 'visibility', only ? 'visible' : 'none');
  }

  function addOverlay() {
    // The globe: MapLibre draws the same style on a sphere until about zoom 6, then eases
    // into the flat map, so city streets look the way they always do.
    map.setProjection({ type: 'globe' });
    const t = BASEMAP[currentTheme];
    // Space behind the planet (the container's background shows through) and a thin
    // Sound-blue atmosphere at the rim that fades out as you zoom in.
    container.style.background = t.space;
    map.setSky({ 'sky-color': t.space, 'horizon-color': '#4f8fa3', 'fog-color': t.space, 'sky-horizon-blend': 0.5, 'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 7, 0] });
    tintBasemap();

    map.addSource('transit', { type: 'vector', url: tiles, attribution: '' });
    const firstLabel = map.getStyle().layers?.find((l) => l.type === 'symbol')?.id;
    for (const mode of MODE_ORDER) {
      const heavy = mode === 'rail' || mode === 'tram' || mode === 'ferry';
      map.addLayer(
        {
          id: `routes-${mode}`,
          type: 'line',
          source: 'transit',
          'source-layer': 'routes',
          filter: ['==', ['get', 'mode'], mode],
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: {
            // The hierarchy: trains, trams and ferries in their colors at every zoom; buses
            // as one quiet gray network until street level, where their own colors help.
            'line-color': heavy ? ['get', 'color'] : ['step', ['zoom'], t.network, BUS_COLOR_ZOOM, ['get', 'color']],
            // Hairlines from orbit, full strokes at street level.
            'line-width': heavy ? ['interpolate', ['linear'], ['zoom'], 2, 0.8, 8, 2, 14, 5] : ['interpolate', ['linear'], ['zoom'], 7, 0.4, 12, 0.9, 14, 3],
            'line-opacity': heavy ? 0.95 : ['interpolate', ['linear'], ['zoom'], 7, 0.45, 12, 0.6, BUS_COLOR_ZOOM, 0.85],
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
        minzoom: 11,
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 1.5, 16, 5],
          'circle-color': t.halo,
          'circle-stroke-color': currentTheme === 'dark' ? '#e4ebed' : '#0f1a1d',
          'circle-stroke-width': 1,
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
      const base = heavy ? 0.95 : (['interpolate', ['linear'], ['zoom'], 7, 0.45, 12, 0.6, BUS_COLOR_ZOOM, 0.85] as maplibregl.ExpressionSpecification);
      map.setPaintProperty(id, 'line-opacity', match ? ['case', match, 1, 0.12] : base);
      // A focused bus route shows its own color at any zoom.
      if (!heavy) map.setPaintProperty(id, 'line-color', match ? ['case', match, ['get', 'color'], BASEMAP[currentTheme].network] : ['step', ['zoom'], BASEMAP[currentTheme].network, BUS_COLOR_ZOOM, ['get', 'color']]);
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
      return;
    }
    if (!hits.length) {
      setFocus(null);
      return;
    }
    const first = hits[0].properties as { feed: string; rid: string | number };
    setFocus({ feed: first.feed, rid: String(first.rid) });
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
    if (!dense.length) dense = await fetch('/transit/globe/search-dense.json').then((r) => r.json()).catch(() => []);
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

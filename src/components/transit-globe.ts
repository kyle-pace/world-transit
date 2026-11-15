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

type Mode = 'bus' | 'rail' | 'tram' | 'ferry' | 'other';

const STYLES = {
  light: 'https://tiles.openfreemap.org/styles/positron',
  dark: 'https://tiles.openfreemap.org/styles/dark',
};
// Keep in step with BASEMAP in transit-map.ts and src/styles/theme.css.
const BASEMAP = {
  light: { land: '#eceee8', water: '#b3cad2', green: null, space: '#16242a', halo: '#ffffff' },
  dark: { land: '#1b2326', water: '#1a3440', green: '#20292c', space: '#040708', halo: '#121719' },
};
const MODE_NAMES: Record<Mode, string> = { bus: 'Bus', rail: 'Train', tram: 'Light rail or streetcar', ferry: 'Ferry', other: 'Other' };
// Drawn bottom to top, so trains sit over the buses that feed them.
const MODE_ORDER: Mode[] = ['bus', 'other', 'ferry', 'tram', 'rail'];

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
  map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: 'Routes from agency schedules (GTFS) via the Mobility Database' }), 'bottom-left');
  // MapLibre opens the compact credits at first; on phones fold them to the (i) button.
  map.once('load', () => {
    if (matchMedia('(max-width: 47.99rem)').matches) container.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
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
    for (const mode of MODE_ORDER) {
      const id = `routes-${mode}`;
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', modes.includes(mode) ? 'visible' : 'none');
    }
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
            'line-color': ['get', 'color'],
            // Hairlines from orbit, full strokes at street level.
            'line-width': heavy ? ['interpolate', ['linear'], ['zoom'], 2, 0.8, 8, 2, 14, 5] : ['interpolate', ['linear'], ['zoom'], 5, 0.4, 9, 1, 14, 3],
            'line-opacity': heavy ? 0.95 : ['interpolate', ['linear'], ['zoom'], 5, 0.5, 10, 0.85],
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
    applyFilters();
  }
  map.on('style.load', addOverlay);

  modeInputs.forEach((i) => i.addEventListener('change', applyFilters));

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
    if (!hits.length) return;
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
      sub.textContent = `${MODE_NAMES[p.mode] ?? 'Route'}, ${p.agency}`;
      li.append(swatch, name, sub);
      list.append(li);
    }
    popup = new maplibregl.Popup({ maxWidth: '20rem' }).setLngLat(e.lngLat).setDOMContent(list).addTo(map);
  });
  for (const id of routeLayers) {
    map.on('mouseenter', id, () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', id, () => (map.getCanvas().style.cursor = ''));
  }

  // Jump buttons: fly to a region (or jump, with reduced motion).
  root.querySelectorAll<HTMLButtonElement>('[data-fly]').forEach((b) =>
    b.addEventListener('click', () => {
      const [lon, lat, z] = b.dataset.fly!.split(',').map(Number);
      // "The whole country" (zoom 0 in the list) goes back to the starting view for this screen.
      const target = { center: [lon, lat] as [number, number], zoom: z || homeZoom(), pitch: 0, bearing: 0 };
      if (reducedMotion()) map.jumpTo(target);
      else map.flyTo({ ...target, duration: 2500, essential: false });
    }),
  );

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

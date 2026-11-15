/*
  "Where am I?" for the globe (/world-transit/): once you zoom in past the planet view, a
  small globe in the corner turns to face where you're looking, with a dot on the spot,
  and a line says the nearest city ("Near Lyon, France").

  The coastlines are world-atlas's 1:110m land (a small file, loaded the first time the
  locator shows), drawn with an orthographic projection by hand: no map library needed
  for a 96-pixel globe. The nearest city comes from the search index of cities of 50,000+.
*/
import type { Map as MapLibreMap } from 'maplibre-gl';
import { feature } from 'topojson-client';

/** Below this zoom the real globe is on screen, so the locator hides. */
const SHOW_FROM_ZOOM = 4.5;

type Ring = [number, number][];
/** [name, ascii name, country, latitude, longitude, population, state or province] */
type PlaceRow = [string, string, string, number, number, number, string?];

export function globeLocator(root: HTMLElement, map: MapLibreMap, theme: () => 'light' | 'dark') {
  const box = root.querySelector<HTMLElement>('[data-locator]');
  const canvas = box?.querySelector('canvas');
  const near = box?.querySelector<HTMLElement>('[data-near]');
  if (!box || !canvas || !near) return;
  const ctx = canvas.getContext('2d')!;

  let rings: Ring[] | null = null;
  let places: PlaceRow[] | null = null;
  let loading: Promise<void> | null = null;
  const load = () =>
    (loading ??= Promise.all([
      import('world-atlas/land-110m.json').then((m) => {
        const topo = (m as { default: unknown }).default as Parameters<typeof feature>[0] & { objects: { land: Parameters<typeof feature>[1] } };
        const land = feature(topo, topo.objects.land) as unknown as GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon>;
        rings = land.features.flatMap((f) => (f.geometry.type === 'Polygon' ? f.geometry.coordinates : f.geometry.coordinates.flat())) as Ring[];
      }),
      fetch('/world-transit/search-places.json')
        .then((r) => r.json())
        .then((p: PlaceRow[]) => {
          places = p;
        }),
    ]).then(() => undefined));

  const countryName = (() => {
    const names = new Intl.DisplayNames(['en'], { type: 'region' });
    return (code: string) => {
      try {
        return names.of(code) ?? code;
      } catch {
        return code;
      }
    };
  })();

  function draw(lon0: number, lat0: number) {
    const dpr = window.devicePixelRatio || 1;
    const size = canvas!.clientWidth;
    canvas!.width = size * dpr;
    canvas!.height = size * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const r = size / 2 - 2;
    const cx = size / 2;
    const cy = size / 2;
    const dark = theme() === 'dark';
    const rad = Math.PI / 180;
    const sinLat0 = Math.sin(lat0 * rad);
    const cosLat0 = Math.cos(lat0 * rad);

    // Ocean disc.
    ctx.clearRect(0, 0, size, size);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, 2 * Math.PI);
    ctx.fillStyle = dark ? '#1f4150' : '#b3cad2';
    ctx.fill();
    ctx.strokeStyle = dark ? '#9badb3' : '#46545a';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Coastlines on the near side only; a line breaks where it goes round the back.
    ctx.beginPath();
    for (const ring of rings ?? []) {
      let drawing = false;
      for (const [lon, lat] of ring) {
        const dl = (lon - lon0) * rad;
        const cosLat = Math.cos(lat * rad);
        const visible = sinLat0 * Math.sin(lat * rad) + cosLat0 * cosLat * Math.cos(dl) > 0;
        if (!visible) {
          drawing = false;
          continue;
        }
        const x = cx + r * cosLat * Math.sin(dl);
        const y = cy - r * (cosLat0 * Math.sin(lat * rad) - sinLat0 * cosLat * Math.cos(dl));
        if (drawing) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
        drawing = true;
      }
    }
    ctx.strokeStyle = dark ? '#c8d3d6' : '#0f1a1d';
    ctx.lineWidth = 0.8;
    ctx.stroke();

    // You are here: the center of the view, always the middle of the little globe.
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, 2 * Math.PI);
    ctx.fillStyle = dark ? '#6fd0ad' : '#0b5a47';
    ctx.fill();
    ctx.strokeStyle = dark ? '#121719' : '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  /** The nearest city of 50,000+ to the center, by a quick flat distance. */
  function nearest(lon: number, lat: number): string {
    if (!places) return '';
    let best: PlaceRow | null = null;
    let bestD = Infinity;
    const k = Math.cos((lat * Math.PI) / 180);
    for (const p of places) {
      const dx = (p[4] - lon) * k;
      const dy = p[3] - lat;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    // Further than about 150 km from any city: say the country only, or nothing at sea.
    if (!best) return '';
    if (bestD > 1.8) return '';
    return `Near ${[best[0], countryName(best[2])].filter(Boolean).join(', ')}`;
  }

  let lastText = '';
  async function update() {
    const zoom = map.getZoom();
    const show = zoom >= SHOW_FROM_ZOOM;
    box!.hidden = !show;
    if (!show) return;
    await load();
    const c = map.getCenter();
    draw(c.lng, c.lat);
    const text = nearest(c.lng, c.lat) || 'Far from any city';
    if (text !== lastText) near!.textContent = lastText = text;
  }

  map.on('moveend', () => void update());
  map.once('load', () => void update());
  return { redraw: () => void update() };
}

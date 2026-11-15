/*
  Live vehicles on the globe (/transit/globe/), drawn by transit-globe.ts.

  The page knows every live feed's area (src/lib/globe-live.json, written by
  scripts/build-globe.ts). Every 15 seconds while the tab is visible, and right after the
  map stops moving, it asks /transit/api/globe/<feed>.json for the feeds whose areas
  overlap the screen, nearest first and at most MAX_FEEDS. Zoomed out past a region,
  it asks for nothing: a whole country of dots would be noise, and hundreds of requests.

  Each vehicle is colored like its route's line, from the small route lookup the build
  writes per schedule (/transit/globe/routes/<schedule>.json, fetched once per feed).
*/
import maplibregl, { type GeoJSONSource, type Map as MapLibreMap } from 'maplibre-gl';

/** [feed id, agency name, schedule id, [west, south, east, north], vehicles at the last check] */
export type LiveFeedRow = [id: string, name: string, schedule: string, bbox: [number, number, number, number], vehicles?: number];
type RouteInfo = [short: string, long: string, color: string, mode: string, agency: string];
type VehicleRow = [id: string, lon: number, lat: number, bearing: number | null, route: string, label: string, ts: number];

const POLL_MS = 15_000;
const MIN_ZOOM = 7;
const MAX_FEEDS = 30;
const FALLBACK = '#868e96';
const MODE_NAMES: Record<string, string> = { bus: 'Bus', rail: 'Train', tram: 'Light rail or streetcar', ferry: 'Ferry', other: 'Vehicle' };

const ago = (seconds: number) => {
  if (seconds < 5) return 'just now';
  if (seconds < 90) return `${Math.round(seconds)} seconds ago`;
  return `${Math.round(seconds / 60)} minutes ago`;
};

export function liveVehicles(map: MapLibreMap, feeds: LiveFeedRow[], onStatus: (text: string) => void) {
  const routes = new Map<string, Promise<Record<string, RouteInfo>>>(); // schedule -> lookup
  const byFeed = new Map<string, GeoJSON.Feature<GeoJSON.Point>[]>(); // feed -> its vehicles
  let visible = true;
  let timer = 0;
  let generation = 0;

  const lookup = (schedule: string) => {
    let p = routes.get(schedule);
    if (!p) {
      p = fetch(`/transit/globe/routes/${schedule}.json`)
        .then((r) => (r.ok ? r.json() : {}))
        .catch(() => ({}));
      routes.set(schedule, p);
    }
    return p;
  };

  /** Feeds overlapping the screen, nearest first. */
  function feedsInView(): LiveFeedRow[] {
    if (map.getZoom() < MIN_ZOOM) return [];
    const b = map.getBounds();
    const c = map.getCenter();
    return feeds
      .filter(([, , , [w, s, e, n]]) => w <= b.getEast() && e >= b.getWest() && s <= b.getNorth() && n >= b.getSouth())
      .map((f) => {
        const [w, s, e, n] = f[3];
        // Distance to the nearest point of the feed's area (0 when the center is inside).
        const dx = Math.max(w - c.lng, 0, c.lng - e);
        const dy = Math.max(s - c.lat, 0, c.lat - n);
        return [dx * dx + dy * dy, f] as const;
      })
      .sort((a, b) => a[0] - b[0])
      .slice(0, MAX_FEEDS)
      .map(([, f]) => f);
  }

  function draw() {
    const source = map.getSource<GeoJSONSource>('vehicles');
    const features = visible ? [...byFeed.values()].flat() : [];
    source?.setData({ type: 'FeatureCollection', features });
    return features.length;
  }

  async function refresh() {
    window.clearTimeout(timer);
    const run = ++generation;
    const wanted = feedsInView();
    // Forget feeds that scrolled out of view.
    const keep = new Set(wanted.map((f) => f[0]));
    for (const id of byFeed.keys()) if (!keep.has(id)) byFeed.delete(id);
    if (!visible) {
      draw();
    } else if (!wanted.length) {
      draw();
      onStatus(map.getZoom() < MIN_ZOOM ? 'Zoom in to a region to see live vehicles' : 'No live vehicle feeds here');
    } else {
      const now = Math.floor(Date.now() / 1000);
      await Promise.all(
        wanted.map(async ([id, name, schedule]) => {
          try {
            // Only the part of the feed around the screen (half a screen of margin, rounded
            // so neighbors' requests share the browser cache).
            const b = map.getBounds();
            const padX = (b.getEast() - b.getWest()) / 2;
            const padY = (b.getNorth() - b.getSouth()) / 2;
            const r = (x: number) => Math.round(x * 10) / 10;
            const box = [r(b.getWest() - padX), r(Math.max(-90, b.getSouth() - padY)), r(b.getEast() + padX), r(Math.min(90, b.getNorth() + padY))].join(',');
            const res = await fetch(`/transit/api/globe/${id}.json?bbox=${box}`);
            if (!res.ok) return; // keep its last vehicles; try again next round
            const [live, info] = await Promise.all([res.json() as Promise<{ v: VehicleRow[] }>, lookup(schedule)]);
            byFeed.set(
              id,
              live.v.map(([vid, lon, lat, bearing, route, label, ts]) => {
                const r = info[route];
                return {
                  type: 'Feature',
                  geometry: { type: 'Point', coordinates: [lon, lat] },
                  properties: {
                    color: r?.[2] ?? FALLBACK,
                    route: r ? [r[0], r[1]].filter(Boolean).join(' ') : route,
                    mode: r?.[3] ?? 'other',
                    agency: r?.[4] ?? name,
                    label: label || vid,
                    seen: ts ? now - ts : -1,
                    bearing: bearing ?? -1,
                  },
                };
              }),
            );
          } catch {
            // Network hiccup: keep the last positions, try again next round.
          }
        }),
      );
      if (run !== generation) return; // the map moved while we were fetching
      draw();
      // Only what's on screen: a feed overlapping the view can reach far beyond it.
      const b = map.getBounds();
      let count = 0;
      for (const list of byFeed.values()) for (const f of list) if (b.contains(f.geometry.coordinates as [number, number])) count++;
      onStatus(count ? `${count.toLocaleString('en-US')} vehicles moving in view` : 'No vehicles reporting in view right now');
    }
    if (visible && document.visibilityState === 'visible') timer = window.setTimeout(refresh, POLL_MS);
  }

  // Refresh right after the map settles, not on every frame of a pan.
  let settle = 0;
  map.on('moveend', () => {
    window.clearTimeout(settle);
    settle = window.setTimeout(refresh, 300);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
    else window.clearTimeout(timer);
  });

  return {
    /** Add the layer (again after a style change). */
    addLayer(halo: string) {
      map.addSource('vehicles', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'vehicles',
        type: 'circle',
        source: 'vehicles',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, 2.5, 11, 4.5, 15, 7],
          'circle-color': ['get', 'color'],
          'circle-stroke-color': halo,
          'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 7, 0.75, 12, 1.5],
        },
      });
      draw();
    },
    setVisible(on: boolean) {
      visible = on;
      refresh();
    },
    start: refresh,
    /** A popup for a vehicle under the click, if there is one. */
    popupAt(e: maplibregl.MapMouseEvent): maplibregl.Popup | null {
      if (!map.getLayer('vehicles')) return null;
      const box: [maplibregl.PointLike, maplibregl.PointLike] = [
        [e.point.x - 8, e.point.y - 8],
        [e.point.x + 8, e.point.y + 8],
      ];
      const hit = map.queryRenderedFeatures(box, { layers: ['vehicles'] })[0];
      if (!hit) return null;
      const p = hit.properties as { route: string; mode: string; agency: string; label: string; seen: number; color: string };
      const wrap = document.createElement('div');
      wrap.className = 'globe-vehicle';
      const title = document.createElement('strong');
      title.textContent = p.route ? `${MODE_NAMES[p.mode] ?? 'Vehicle'} ${p.route}` : (MODE_NAMES[p.mode] ?? 'Vehicle');
      title.style.setProperty('--route', p.color);
      const agency = document.createElement('span');
      agency.textContent = p.agency;
      const seen = document.createElement('span');
      seen.textContent = p.seen >= 0 ? `Position from ${ago(p.seen)}` : 'Live position';
      wrap.append(title, agency, seen);
      return new maplibregl.Popup({ maxWidth: '18rem' }).setLngLat((hit.geometry as GeoJSON.Point).coordinates as [number, number]).setDOMContent(wrap).addTo(map);
    },
  };
}

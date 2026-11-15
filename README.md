# World transit

Every transit route on Earth with an open schedule, on one globe you can spin and zoom into a single street, with buses, trains and ferries moving live where agencies share their positions.

Live at **[kylepace.dev/world-transit](https://kylepace.dev/world-transit/)**, one of the experiments on [kylepace.dev](https://kylepace.dev). [How it works](https://kylepace.dev/world-transit/about/).

Built with [Astro](https://astro.build) and [MapLibre](https://maplibre.org) on Cloudflare Workers and R2, following [kyle-pace/principles](https://github.com/kyle-pace/principles). It grew out of [Washington transit, live](https://github.com/kyle-pace/wa-transit-map).

## Run it

```sh
npm install
npm run build
npx wrangler dev   # http://localhost:8787/world-transit/
npm test
npm run check
```

The tiles (about 1.8 GB) aren't in the repo: build them with `npm run data` (see AGENTS.md, "The data"), then load them into the local R2 store before `wrangler dev`.

## Where the data comes from

Schedules (GTFS) and live vehicle positions (GTFS-realtime) from each agency, found through the [Mobility Database](https://mobilitydatabase.org), [Transitland](https://www.transit.land) and [Transitous](https://transitous.org); transit lines where there are no open schedules from [OpenStreetMap](https://www.openstreetmap.org/copyright) (© OpenStreetMap contributors, ODbL) via [Geofabrik](https://download.geofabrik.de/); city names from [GeoNames](https://www.geonames.org/) (CC BY 4.0); basemap by [OpenFreeMap](https://openfreemap.org).

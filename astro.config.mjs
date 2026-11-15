// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

// World transit lives at kylepace.dev/world-transit/. It's its own Worker, mounted on
// that path by the routes in wrangler.jsonc; the hub (kyle-pace/kylepace.dev) serves
// everything else on the domain.
// Everything this site serves sits under /world-transit/: pages, the tiles and the live
// API in src/pages/world-transit/, data files in public/world-transit/, and built assets
// in /world-transit/_astro/. (Astro's `base` option isn't used: with the Cloudflare
// adapter it serves the files from the wrong folder.)
// Static by default; the tiles and /world-transit/api/<feed>.json render on request.
export default defineConfig({
  site: 'https://kylepace.dev',
  build: { assets: 'world-transit/_astro' },
  session: false,
  adapter: cloudflare({ imageService: 'compile' }),
});

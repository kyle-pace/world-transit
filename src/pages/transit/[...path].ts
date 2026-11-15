// The Washington live map used to live at /transit/. World transit replaced it, so every
// old address sends people to the closest new page, keeping old links and shared cards
// working: the map opens on Puget Sound, the agencies page on the United States.
import type { APIRoute } from 'astro';

export const prerender = false;

export function newAddress(path: string): string {
  const p = `/${path}`.replace(/\/+$/, '');
  if (p === '' || p === '/') return '/world-transit/?at=-122.33,47.6,9';
  if (p.startsWith('/agencies')) return '/world-transit/agencies/us/';
  if (p.startsWith('/about')) return '/world-transit/about/';
  return '/world-transit/';
}

export const GET: APIRoute = ({ params }) => new Response(null, { status: 301, headers: { location: newAddress(params.path ?? '') } });

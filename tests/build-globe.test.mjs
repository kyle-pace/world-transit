// Tests for the globe build's geometry cleanup (scripts/build-globe.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { breakLongHops } from '../scripts/build-globe.ts';

// Stops about 1 km apart along a street, then one 20 km jump to an airport.
const a = [-122.33, 47.6];
const b = [-122.33, 47.609];
const c = [-122.33, 47.618];
const airport = [-122.3, 47.44];
const stops = new Set([a, b, c, airport].map((p) => `${p[0]},${p[1]}`));

test('a stop-to-stop bus line is cut at a hop no bus makes without stopping', () => {
  assert.deepEqual(breakLongHops([[a, b, c, airport]], stops, 'bus'), [[a, b, c]]);
});

test('trains are allowed long hops between stations', () => {
  assert.deepEqual(breakLongHops([[a, b, c, airport]], stops, 'rail'), [[a, b, c, airport]]);
});

test('a drawn path (points not on stops) is never cut, however straight', () => {
  const drawn = [a, [-122.331, 47.605], [-122.31, 47.5], airport];
  assert.deepEqual(breakLongHops([drawn], stops, 'bus'), [drawn]);
});

test('a line that is only one long hop disappears instead of slicing the map', () => {
  assert.deepEqual(breakLongHops([[c, airport]], stops, 'bus'), []);
});

import { minZoomFor } from '../scripts/build-globe.ts';

test('from orbit only long rail shows; buses and trams wait for region level', () => {
  const long = [[[-122.3, 47.6], [-122.3, 43.5]]]; // ~450 km
  const regional = [[[-122.3, 47.6], [-122.3, 46.3]]]; // ~145 km
  const mid = [[[-122.3, 47.6], [-122.3, 47.3]]]; // ~33 km
  const short = [[[-122.3, 47.6], [-122.3, 47.55]]]; // ~5.5 km
  assert.equal(minZoomFor('rail', long), 0);
  assert.equal(minZoomFor('rail', regional), 3);
  assert.equal(minZoomFor('rail', mid), 5);
  assert.equal(minZoomFor('rail', short), 6);
  assert.equal(minZoomFor('ferry', regional), 3);
  assert.equal(minZoomFor('ferry', short), 6);
  assert.equal(minZoomFor('bus', long), 7);
  assert.equal(minZoomFor('tram', short), 7);
});

import { corridorZoom } from '../scripts/build-globe.ts';

test('from orbit, a second train on the same corridor waits for zoom 5', () => {
  const claimed = new Set();
  const line = [[[116.4, 39.9], [117.2, 39.1], [118.0, 38.0], [121.47, 31.23]]]; // Beijing–Shanghai-ish
  assert.equal(corridorZoom(0, line, claimed), 0, 'the first one shows from orbit');
  assert.equal(corridorZoom(0, line, claimed), 5, 'the same tracks again wait');
  const other = [[[-0.12, 51.5], [-1.9, 52.48], [-2.24, 53.48]]]; // London–Manchester-ish
  assert.equal(corridorZoom(0, other, claimed), 0, 'a new corridor still shows');
  assert.equal(corridorZoom(6, line, claimed), 6, 'lines that start at 5+ are left alone');
});

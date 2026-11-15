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

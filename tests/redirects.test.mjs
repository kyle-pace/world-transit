// The old Washington map's addresses (/transit/...) send people to the closest page of
// World transit, so old links and shared cards keep working.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newAddress } from '../src/pages/transit/[...path].ts';

test('old Washington addresses land on the closest new page', () => {
  assert.equal(newAddress(''), '/world-transit/?at=-122.33,47.6,9', 'the map opens on Puget Sound');
  assert.equal(newAddress('/'), '/world-transit/?at=-122.33,47.6,9');
  assert.equal(newAddress('agencies/'), '/world-transit/agencies/us/');
  assert.equal(newAddress('about'), '/world-transit/about/');
  assert.equal(newAddress('globe/'), '/world-transit/');
  assert.equal(newAddress('api/vehicles.json'), '/world-transit/');
});

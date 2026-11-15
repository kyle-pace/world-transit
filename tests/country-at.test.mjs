// Tests for the offline country lookup (scripts/country-at.ts), used for feeds whose
// catalog doesn't say which country they're in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { countryAt } from '../scripts/country-at.ts';

test('cities land in their countries, including renamed and aliased ones', () => {
  for (const [lon, lat, code] of [
    [-122.33, 47.6, 'US'],
    [2.35, 48.86, 'FR'],
    [28.98, 41.03, 'TR'],
    [15.3, -4.3, 'CD'],
    [-4.0, 5.33, 'CI'],
    [18.4, 43.85, 'BA'],
    [114.17, 22.32, 'HK'],
  ])
    assert.equal(countryAt(lon, lat), code, `${lon},${lat}`);
});

test('the open ocean is no country', () => {
  assert.equal(countryAt(-40, 30), '');
});

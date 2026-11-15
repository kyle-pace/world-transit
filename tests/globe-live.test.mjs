// Tests for the globe's per-feed live answer (src/lib/globe-live.ts): what it keeps from a
// real feed, and what it refuses. samples/island-transit-vehicles.pb is a real feed saved
// 2026-11-14.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { decodeFeed } from '../src/lib/gtfs-rt.ts';
import { compactFeed, fetchLiveFeed, MAX_AGE_SECONDS } from '../src/lib/globe-live.ts';

const realBytes = readFileSync(new URL('./samples/island-transit-vehicles.pb', import.meta.url));
const real = decodeFeed(new Uint8Array(realBytes));
// "Now" as of the sample, so its vehicles count as fresh.
const sampleNow = Math.max(real.timestamp, ...real.vehicles.map((v) => v.timestamp));

test('a real feed becomes compact rows with positions, routes and times', () => {
  const live = compactFeed(real, sampleNow);
  assert.ok(live.v.length >= 1);
  for (const [id, lon, lat, , route, , ts] of live.v) {
    assert.ok(id, 'each vehicle has an id');
    assert.ok(lat > 45 && lat < 49.5 && lon > -125.5 && lon < -116, `${id} is in Washington`);
    assert.equal(typeof route, 'string');
    assert.ok(ts > 1_700_000_000);
  }
});

test('positions older than the cutoff are left off', () => {
  assert.deepEqual(compactFeed(real, sampleNow + MAX_AGE_SECONDS + 3600).v, []);
});

test('vehicles at 0,0 or off the planet are dropped, the rest kept', () => {
  const good = real.vehicles[0];
  const feed = {
    timestamp: sampleNow,
    vehicles: [good, { ...good, id: 'null-island', lat: 0, lon: 0 }, { ...good, id: 'nowhere', lat: 123, lon: 456 }, { ...good, id: 'nan', lat: NaN }],
  };
  assert.deepEqual(
    compactFeed(feed, sampleNow).v.map((v) => v[0]),
    [good.id || good.label],
  );
});

// A local server standing in for agencies' servers.
async function serve(handler) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, r));
  return { url: `http://localhost:${server.address().port}/`, close: () => server.close() };
}

test('fetching a real feed works end to end', async () => {
  const s = await serve((_, res) => res.end(realBytes));
  try {
    const feed = await fetchLiveFeed(s.url);
    assert.equal(feed.vehicles.length, real.vehicles.length);
  } finally {
    s.close();
  }
});

test('an error page or an HTTP error is refused, not decoded', async () => {
  const page = await serve((_, res) => res.end('<html><body>Service unavailable</body></html>'));
  const down = await serve((_, res) => {
    res.statusCode = 503;
    res.end();
  });
  try {
    await assert.rejects(fetchLiveFeed(page.url), /not protobuf/);
    await assert.rejects(fetchLiveFeed(down.url), /HTTP 503/);
  } finally {
    page.close();
    down.close();
  }
});

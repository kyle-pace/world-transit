// Tests for reading OpenStreetMap transit relations (scripts/build-osm.ts) from osmium's
// plain-text (OPL) output. samples/osm-costa-rica-relations.opl is real data from the
// Costa Rica extract, saved 2026-11-15 (© OpenStreetMap contributors, ODbL).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { colorOf, parseRelation, tagsOf } from '../scripts/build-osm.ts';

const lines = readFileSync(new URL('./samples/osm-costa-rica-relations.opl', import.meta.url), 'utf8').trim().split('\n');

test('real relations give an id, readable tags and their ways', () => {
  for (const line of lines) {
    const r = parseRelation(line);
    assert.ok(r, 'parsed');
    assert.match(r.id, /^\d+$/);
    assert.ok(['bus', 'train'].includes(r.tags.route), `route=${r.tags.route}`);
    for (const w of r.ways) assert.match(w, /^w\d+$/, 'ways are plain ids, no @ suffix');
  }
  const named = parseRelation(lines.find((l) => l.includes('Residencias')));
  assert.equal(named.tags.name, 'via Acceso a Residencias Estudiantiles', 'OPL escapes become spaces');
  assert.equal(named.tags.ref, 'santa rosa');
});

test('nodes, ways and junk are not relations', () => {
  assert.equal(parseRelation('n123 v1 x1 y2'), null);
  assert.equal(parseRelation('w123 v1 Tname=x Nn1,n2'), null);
  assert.equal(parseRelation(''), null);
  assert.equal(parseRelation('rabc v1'), null);
});

test('a relation with no tags or members is empty, not a crash', () => {
  assert.deepEqual(parseRelation('r42 v1 dV'), { id: '42', tags: {}, ways: [] });
  assert.deepEqual(tagsOf('broken,=x,also=fine'), { also: 'fine' });
});

test('colors: hex kept, short hex expanded, names and junk fall back', () => {
  assert.equal(colorOf('#FF0000', '#000001'), '#ff0000');
  assert.equal(colorOf('#0a3', '#000001'), '#00aa33');
  assert.equal(colorOf('red', '#000001'), '#000001');
  assert.equal(colorOf('#12345', '#000001'), '#000001');
  assert.equal(colorOf(undefined, '#000001'), '#000001');
});

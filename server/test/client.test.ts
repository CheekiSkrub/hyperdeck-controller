import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asyncKind } from '../src/hyperdeck/client.js';

const r = (code: number, text: string) => ({ code, text, lines: [], params: {} });

test('async notifications are recognised by title, whatever their code', () => {
  // HyperDeck Shuttle HD, protocol 1.18
  assert.equal(asyncKind(r(513, 'display timecode')), 'display timecode');
  assert.equal(asyncKind(r(514, 'timeline position')), 'timeline position');
  assert.equal(asyncKind(r(520, 'disk list info')), 'disk');
  assert.equal(asyncKind(r(508, 'transport info')), 'transport');
  assert.equal(asyncKind(r(502, 'slot info')), 'slot');
  // Older numbering / "info" suffixes
  assert.equal(asyncKind(r(516, 'timeline position info')), 'timeline position');
  assert.equal(asyncKind(r(512, 'clips info')), 'clips');
  // Unknown title falls back to the code; unknown both -> null
  assert.equal(asyncKind(r(510, 'something new')), 'remote');
  assert.equal(asyncKind(r(599, 'mystery')), null);
});

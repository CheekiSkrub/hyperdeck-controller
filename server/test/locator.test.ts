import assert from 'node:assert/strict';
import test from 'node:test';
import { MediaLocator } from '../src/media/locator.js';

const loc = new MediaLocator({} as never);

test('resolveEntryPath accepts files at the root of a UNC share', { skip: process.platform !== 'win32' }, () => {
  const root = '\\\\nas.local\\BM';
  assert.equal(loc.resolveEntryPath(root, 'clip.mp4'), '\\\\nas.local\\BM\\clip.mp4');
  assert.equal(loc.resolveEntryPath(root, 'sub/clip.mp4'), '\\\\nas.local\\BM\\sub\\clip.mp4');
  // ".." can't climb above a UNC share root — Windows clamps it back inside the share.
  assert.equal(loc.resolveEntryPath(root, '../other/clip.mp4'), '\\\\nas.local\\BM\\other\\clip.mp4');
  assert.equal(loc.resolveEntryPath('\\\\nas.local\\BM\\sub', '../x.mp4'), null);
});

test('resolveEntryPath keeps paths inside a local folder', () => {
  const root = process.platform === 'win32' ? 'C:\\media' : '/media';
  assert.ok(loc.resolveEntryPath(root, 'a/b.mov')?.endsWith('b.mov'));
  assert.equal(loc.resolveEntryPath(root, '../etc/passwd'), null);
  assert.equal(loc.resolveEntryPath(root, '../media2/x.mov'), null);
});

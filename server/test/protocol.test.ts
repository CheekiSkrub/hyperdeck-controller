import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildCommand, fpsFromVideoFormat, framesToTimecode, parseClipsGet, parseDiskList, parseTransportInfo,
  ResponseParser, timecodeToFrames, type HyperDeckResponse,
} from '../src/hyperdeck/protocol.js';
import { bisectionOrder } from '../src/media/service.js';
import { normaliseShareUrl } from '../src/media/locator.js';

test('parser handles single and multi-line responses split across chunks', () => {
  const out: HyperDeckResponse[] = [];
  const p = new ResponseParser((r) => out.push(r));
  p.push('500 connection info:\r\nprotocol version: 1.13\r\nmodel: HyperDeck Studio HD Pro\r\n\r\n200 o');
  p.push('k\r\n508 transport info:\r\nstatus: play\r\n');
  p.push('speed: 100\r\n\r\n102 invalid value\r\n');
  assert.equal(out.length, 4);
  assert.equal(out[0].code, 500);
  assert.equal(out[0].params.model, 'HyperDeck Studio HD Pro');
  assert.equal(out[1].text, 'ok');
  assert.deepEqual(out[2].params, { status: 'play', speed: '100' });
  assert.equal(out[3].code, 102);
});

test('buildCommand formats parameters', () => {
  assert.equal(buildCommand('play'), 'play\r\n');
  assert.equal(buildCommand('goto', { 'clip id': 3 }), 'goto: clip id: 3\r\n');
  assert.equal(buildCommand('record', { name: 'bad\r\nname' }), 'record: name: bad  name\r\n');
});

test('disk list keeps spaces in file names', () => {
  const { slotId, clips } = parseDiskList([
    'slot id: 1',
    '1: Studio Cam A_0001.mov QuickTimeProResHQ 1080p25 00:00:20:00',
    '2: Interview.mp4 H.264High 2160p2997 01:02:03:04',
  ]);
  assert.equal(slotId, 1);
  assert.equal(clips[0].name, 'Studio Cam A_0001.mov');
  assert.equal(clips[0].fileFormat, 'QuickTimeProResHQ');
  assert.equal(clips[1].videoFormat, '2160p2997');
  assert.equal(clips[1].duration, '01:02:03:04');
});

test('clips get parses v1 and v3', () => {
  const v1 = parseClipsGet(['clip count: 1', '1: My Clip 00:00:00:00 00:00:10:00']);
  assert.deepEqual(v1[0], { id: 1, name: 'My Clip', startTimecode: '00:00:00:00', duration: '00:00:10:00' });
  const v3 = parseClipsGet(['2: 10:00:00:00 00:00:05:00 00:00:10:00 00:00:15:00 ssd1/My Clip.mov']);
  assert.equal(v3[0].name, 'ssd1/My Clip.mov');
  assert.equal(v3[0].inTimecode, '00:00:10:00');
});

test('transport notifications merge onto previous state', () => {
  const a = parseTransportInfo({ status: 'stopped', speed: '0', 'clip id': '2', 'video format': '1080p25' });
  const b = parseTransportInfo({ status: 'play', speed: '100' }, a);
  assert.equal(b.status, 'play');
  assert.equal(b.clipId, 2);
  assert.equal(b.videoFormat, '1080p25');
});

test('frame rates and timecode maths', () => {
  assert.equal(fpsFromVideoFormat('1080p5994'), 59.94);
  assert.equal(fpsFromVideoFormat('1080i50'), 25);
  assert.equal(fpsFromVideoFormat('4Kp23976'), 23.976);
  assert.equal(timecodeToFrames('00:01:00:00', 25), 1500);
  assert.equal(framesToTimecode(1501, 25), '00:01:00:01');
  // drop-frame round trip
  for (const f of [0, 1799, 1800, 17982, 107892]) {
    assert.equal(timecodeToFrames(framesToTimecode(f, 29.97, true), 29.97), f);
  }
  assert.equal(framesToTimecode(1800, 29.97, true), '00:01:00;02');
});

test('filmstrip bisection order covers every tile once, coarse first', () => {
  const o = bisectionOrder(10);
  assert.equal(o.length, 10);
  assert.equal(new Set(o).size, 10);
  assert.equal(o[0], 0);
});

test('share URL normalisation matches smb and UNC forms', () => {
  assert.equal(normaliseShareUrl('smb://NAS.local/Recordings/'), normaliseShareUrl('\\\\nas.local\\recordings'));
});

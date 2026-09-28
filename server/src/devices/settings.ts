import type { HyperDeckClient } from '../hyperdeck/client.js';
import type { HyperDeckRest } from '../hyperdeck/rest.js';

/**
 * The deck's setup menu as a flat list of setting descriptors the panel can
 * render generically. Values come from the Ethernet protocol ("configuration",
 * "play option", "play on startup", "remote", "dynamic range") and, when the
 * deck answers it, the REST API (codec and video-format lists, audio record
 * format, input source, monitoring overlays).
 */
export type SettingType = 'select' | 'bool' | 'text' | 'number' | 'timecode' | 'info';

export interface Setting {
  id: string;
  group: string;
  label: string;
  type: SettingType;
  value: string | number | boolean | null;
  options?: { value: string; label: string }[];
  help?: string;
  readOnly?: boolean;
}

export interface SettingsSnapshot {
  rest: boolean;
  settings: Setting[];
  /** Setup-menu entries the deck reported that we don't have a UI for; shown as raw text fields. */
  errors: string[];
}

/** Stable JSON (sorted keys) so a deck's value matches the same entry in its supported list. */
const canon = (o: unknown): string => JSON.stringify(o, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));

const opts = (...v: string[]) => v.map((x) => ({ value: x, label: x }));

/** Known `configuration` keys with their protocol values (Blackmagic Ethernet Protocol). */
const CONFIG: Record<string, { group: string; label: string; type: SettingType; options?: { value: string; label: string }[]; help?: string }> = {
  'video input': { group: 'Video', label: 'Video input', type: 'select', options: opts('SDI', '4xSDI', 'HDMI', 'component', 'composite', 'optical') },
  'default standard': { group: 'Video', label: 'Default standard (no input)', type: 'text', help: 'e.g. 1080p25, 2160p5994' },
  'reference source': { group: 'Video', label: 'Reference source', type: 'select', options: opts('auto', 'input', 'external') },
  'genlock input resync': { group: 'Video', label: 'Genlock input resync', type: 'bool' },
  'audio input': { group: 'Audio', label: 'Audio input', type: 'select', options: opts('embedded', 'XLR', 'RCA') },
  'audio codec': { group: 'Audio', label: 'Audio codec', type: 'select', options: opts('PCM', 'AAC') },
  'audio input channels': { group: 'Audio', label: 'Audio channels', type: 'select', options: opts('2', '4', '8', '16', '32', '64') },
  'xlr mapping': { group: 'Audio', label: 'XLR mapping', type: 'text' },
  'rca mapping': { group: 'Audio', label: 'RCA mapping', type: 'text' },
  'file format': {
    group: 'Record', label: 'Codec / file format', type: 'select',
    options: opts(
      'QuickTimeUncompressed', 'QuickTimeProResHQ', 'QuickTimeProRes', 'QuickTimeProResLT', 'QuickTimeProResProxy',
      'QuickTimeDNxHD220x', 'QuickTimeDNxHD145', 'QuickTimeDNxHD45', 'DNxHD220x', 'DNxHD145', 'DNxHD45',
      'QuickTimeDNxHR_HQX', 'QuickTimeDNxHR_SQ', 'QuickTimeDNxHR_LB', 'DNxHR_HQX', 'DNxHR_SQ', 'DNxHR_LB',
      'H.264High_SDI', 'H.264High', 'H.264Medium', 'H.264Low', 'H.265High_SDI', 'H.265High', 'H.265Medium', 'H.265Low',
    ),
    help: 'Codecs vary by model; the deck rejects ones it doesn\'t support.',
  },
  'record trigger': { group: 'Record', label: 'Record trigger', type: 'select', options: opts('none', 'recordbit', 'timecoderun') },
  'record prefix': { group: 'Record', label: 'File name prefix', type: 'text' },
  'append timestamp': { group: 'Record', label: 'Append timestamp to file name', type: 'bool' },
  'record cache': { group: 'Record', label: 'Record cache', type: 'bool' },
  'usb spill': { group: 'Record', label: 'Spill to USB', type: 'bool' },
  'timecode input': { group: 'Timecode', label: 'Timecode input', type: 'select', options: opts('external', 'embedded', 'internal', 'preset', 'clip') },
  'timecode output': { group: 'Timecode', label: 'Timecode output', type: 'select', options: opts('clip', 'timeline') },
  'timecode preference': { group: 'Timecode', label: 'Timecode preference', type: 'select', options: opts('default', 'dropframe', 'nondropframe') },
  'timecode preset': { group: 'Timecode', label: 'Timecode preset', type: 'timecode' },
};

const DYNAMIC_RANGE = opts('off', 'Rec709', 'Rec2020_SDR', 'HLG', 'ST2084_300', 'ST2084_500', 'ST2084_800', 'ST2084_1000', 'ST2084_2000', 'ST2084_4000', 'ST2084');

function toValue(type: SettingType, raw: string | undefined): string | number | boolean | null {
  if (raw === undefined) return null;
  if (type === 'bool') return raw === 'true';
  return raw;
}

export async function readSettings(c: HyperDeckClient, rest: HyperDeckRest): Promise<SettingsSnapshot> {
  const settings: Setting[] = [];
  const errors: string[] = [];
  const hasRest = await rest.available();

  // ------------------------------------------------------------ Ethernet protocol
  try {
    const cfg = await c.send('configuration');
    for (const [key, raw] of Object.entries(cfg.params)) {
      const known = CONFIG[key];
      if (/^xlr input id/.test(key)) continue; // multi-part; exposed via its own rows below
      settings.push(known
        ? { id: `cfg:${key}`, group: known.group, label: known.label, type: known.type, value: toValue(known.type, raw), options: withCurrent(known.options, raw), help: known.help }
        : { id: `cfg:${key}`, group: 'Other', label: key[0].toUpperCase() + key.slice(1), type: raw === 'true' || raw === 'false' ? 'bool' : 'text', value: raw === 'true' || raw === 'false' ? raw === 'true' : raw });
    }
  } catch (e) {
    errors.push(`configuration: ${(e as Error).message}`);
  }

  await c.send('play option').then((r) => {
    if (r.params['stop mode']) settings.push({ id: 'play:stop mode', group: 'Playback', label: 'Stop mode', type: 'select', value: r.params['stop mode'], options: opts('lastframe', 'nextframe', 'black') });
  }).catch(() => {});
  await c.send('play on startup').then((r) => {
    if ('enable' in r.params) settings.push({ id: 'startup:enable', group: 'Playback', label: 'Play on startup', type: 'bool', value: r.params.enable === 'true' });
    if ('single clip' in r.params) settings.push({ id: 'startup:single clip', group: 'Playback', label: 'Play on startup: single clip', type: 'bool', value: r.params['single clip'] === 'true' });
  }).catch(() => {});
  await c.send('dynamic range').then((r) => {
    if ('playback override' in r.params) settings.push({ id: 'dr:playback override', group: 'Video', label: 'HDR playback override', type: 'select', value: r.params['playback override'], options: withCurrent(DYNAMIC_RANGE, r.params['playback override']) });
    if ('record override' in r.params) settings.push({ id: 'dr:record override', group: 'Video', label: 'HDR record override', type: 'select', value: r.params['record override'], options: withCurrent(DYNAMIC_RANGE, r.params['record override']) });
  }).catch(() => {});
  if (c.state.remote) {
    settings.push({ id: 'remote:enable', group: 'System', label: 'Remote control enabled', type: 'bool', value: c.state.remote.enabled, help: 'Turning this off makes the deck refuse transport commands from this panel.' });
  }

  // ------------------------------------------------------------ REST extras
  if (hasRest) {
    const tryGet = async <T>(path: string) => rest.get<T>(path).catch(() => null);
    const [codec, codecs, vf, vfs, audio, audios, src, srcs, product, displays] = await Promise.all([
      tryGet<{ codec: string; container?: string }>('/system/codecFormat'),
      tryGet<{ codecs: { codec: string; container?: string }[] }>('/system/supportedCodecFormats'),
      tryGet<Record<string, unknown>>('/system/videoFormat'),
      tryGet<{ formats: Record<string, unknown>[] }>('/system/supportedVideoFormats'),
      tryGet<{ codec: string; numChannels: number }>('/audio/recordFormat'),
      tryGet<{ supportedRecordFormats: ({ codec?: string; numChannels?: number; format?: { codec: string; numChannels: number }; available?: boolean })[] }>('/audio/supportedRecordFormats'),
      tryGet<{ inputVideoSource: string }>('/transports/0/inputVideoSource'),
      tryGet<{ supportedInputVideoSources: string[] }>('/transports/0/supportedInputVideoSources'),
      tryGet<{ deviceName?: string; productName?: string; softwareVersion?: string }>('/system/product'),
      tryGet<{ displays: string[] }>('/monitoring/display'),
    ]);

    if (codec && codecs?.codecs?.length) {
      drop(settings, 'cfg:file format');
      const label = (x: { codec: string; container?: string }) => `${x.codec}${x.container ? ` (${x.container})` : ''}`;
      settings.push({
        id: 'rest:codecFormat', group: 'Record', label: 'Codec', type: 'select', value: canon(codec),
        options: codecs.codecs.map((x) => ({ value: canon(x), label: label(x) })),
      });
    }
    if (vfs?.formats?.length) {
      const name = (x: Record<string, unknown> | null) => (x?.name as string) ?? '—';
      settings.push({
        id: 'rest:videoFormat', group: 'Video', label: 'Video format', type: 'select', value: vf ? canon(vf) : null,
        options: vfs.formats.map((x) => ({ value: canon(x), label: name(x) })),
        help: 'Recording follows the input when one is connected.',
      });
    }
    if (audio && audios?.supportedRecordFormats?.length) {
      drop(settings, 'cfg:audio codec');
      drop(settings, 'cfg:audio input channels');
      const list = audios.supportedRecordFormats.map((x) => ({ ...(x.format ?? { codec: x.codec!, numChannels: x.numChannels! }), available: x.available !== false }));
      settings.push({
        id: 'rest:audioFormat', group: 'Audio', label: 'Audio record format', type: 'select', value: canon({ codec: audio.codec, numChannels: audio.numChannels }),
        options: list.filter((x) => x.available).map((x) => ({ value: canon({ codec: x.codec, numChannels: x.numChannels }), label: `${x.codec} · ${x.numChannels} ch` })),
      });
    }
    if (src && srcs?.supportedInputVideoSources?.length) {
      drop(settings, 'cfg:video input');
      settings.push({ id: 'rest:inputVideoSource', group: 'Video', label: 'Video input', type: 'select', value: src.inputVideoSource, options: opts(...srcs.supportedInputVideoSources) });
    }
    if (product) {
      settings.push({ id: 'info:product', group: 'System', label: 'Model', type: 'info', value: product.productName ?? null, readOnly: true });
      settings.push({ id: 'info:name', group: 'System', label: 'Deck name', type: 'info', value: product.deviceName ?? null, readOnly: true });
      settings.push({ id: 'info:software', group: 'System', label: 'Software version', type: 'info', value: product.softwareVersion ?? null, readOnly: true });
    }
    for (const d of displays?.displays ?? []) {
      const features: [string, string][] = [['cleanFeed', 'Clean feed'], ['displayLUT', 'Display LUT'], ['zebra', 'Zebra'], ['focusAssist', 'Focus assist'], ['frameGuide', 'Frame guides'], ['falseColor', 'False color']];
      const vals = await Promise.all(features.map(([f]) => tryGet<{ enabled: boolean }>(`/monitoring/${encodeURIComponent(d)}/${f}`)));
      features.forEach(([f, label], i) => {
        if (vals[i] && typeof vals[i]!.enabled === 'boolean') {
          settings.push({ id: `mon:${d}:${f}`, group: `Monitoring · ${d}`, label, type: 'bool', value: vals[i]!.enabled });
        }
      });
    }
  }
  if (!settings.some((s) => s.id === 'info:software') && c.state.info) {
    settings.push({ id: 'info:product', group: 'System', label: 'Model', type: 'info', value: c.state.info.model ?? null, readOnly: true });
    settings.push({ id: 'info:software', group: 'System', label: 'Software version', type: 'info', value: c.state.info.softwareVersion ?? null, readOnly: true });
  }
  return { rest: hasRest, settings, errors };
}

function drop(list: Setting[], id: string) {
  const i = list.findIndex((s) => s.id === id);
  if (i >= 0) list.splice(i, 1);
}

/** Make sure the deck's current value is selectable even if it's not in our list. */
function withCurrent(options: { value: string; label: string }[] | undefined, current: string | undefined) {
  if (!options) return undefined;
  if (current === undefined || options.some((o) => o.value === current)) return options;
  return [{ value: current, label: current }, ...options];
}

export class SettingError extends Error {}

export async function writeSetting(c: HyperDeckClient, rest: HyperDeckRest, id: string, value: unknown): Promise<void> {
  const [kind, ...rest_] = id.split(':');
  const key = rest_.join(':');
  const str = typeof value === 'boolean' ? String(value) : String(value ?? '');
  if (/[\r\n]/.test(str)) throw new SettingError('Value may not contain line breaks');
  switch (kind) {
    case 'cfg':
      if (!CONFIG[key] && !/^[a-z ]+$/.test(key)) throw new SettingError('Unknown setting');
      await c.send('configuration', { [key]: str });
      return;
    case 'play':
      await c.send('play option', { [key]: str });
      return;
    case 'startup':
      await c.send('play on startup', { [key]: str });
      return;
    case 'dr':
      await c.send('dynamic range', { [key]: str });
      return;
    case 'remote':
      await c.send('remote', { enable: str });
      await c.refreshRemote();
      return;
    case 'rest': {
      const parse = () => {
        try { return JSON.parse(str); } catch { throw new SettingError('Invalid value'); }
      };
      if (key === 'codecFormat') return rest.send('PUT', '/system/codecFormat', parse());
      if (key === 'videoFormat') return rest.send('PUT', '/system/videoFormat', parse());
      if (key === 'audioFormat') return rest.send('PUT', '/audio/recordFormat', parse());
      if (key === 'inputVideoSource') return rest.send('PUT', '/transports/0/inputVideoSource', { inputVideoSource: str });
      throw new SettingError('Unknown setting');
    }
    case 'mon': {
      const i = key.lastIndexOf(':');
      const display = key.slice(0, i);
      const feature = key.slice(i + 1);
      if (!['cleanFeed', 'displayLUT', 'zebra', 'focusAssist', 'frameGuide', 'falseColor'].includes(feature)) throw new SettingError('Unknown setting');
      return rest.send('PUT', `/monitoring/${encodeURIComponent(display)}/${feature}`, { enabled: value === true || value === 'true' });
    }
    default:
      throw new SettingError('This setting is read-only');
  }
}

/** One-off device actions from the settings page. */
export async function deviceAction(c: HyperDeckClient, rest: HyperDeckRest, action: string, body: Record<string, unknown>): Promise<unknown> {
  switch (action) {
    case 'identify':
      await c.send('identify', { enable: body.enable !== false });
      return { ok: true };
    case 'reboot':
      if (c.state.transport?.status === 'record') throw new SettingError("Stop recording before rebooting the deck");
      await c.send('reboot').catch(() => {}); // the deck may drop the connection before replying
      return { ok: true };
    case 'format': {
      const slotId = Number(body.slotId);
      const fs = body.filesystem === 'HFS+' ? 'HFS+' : 'exFAT';
      const name = String(body.name ?? '').trim();
      if (!Number.isInteger(slotId)) throw new SettingError('Choose a slot to format');
      if (!/^[\w .-]{1,32}$/.test(name)) throw new SettingError('Volume name: 1–32 letters, numbers, spaces, dots, dashes');
      if (c.state.transport?.status === 'record') throw new SettingError("Can't format while recording");
      const prep = await c.send('format', { 'slot id': slotId, prepare: fs, name });
      const token = prep.params.token ?? prep.lines.map((l) => /token:\s*(\S+)/.exec(l)?.[1]).find(Boolean) ?? prep.text.split(/\s+/).pop();
      if (!token) throw new SettingError('The deck did not return a format confirmation token');
      await c.send('format', { confirm: token }, 120000);
      await c.refreshSlots();
      return { ok: true };
    }
    default:
      void rest;
      throw new SettingError('Unknown action');
  }
}

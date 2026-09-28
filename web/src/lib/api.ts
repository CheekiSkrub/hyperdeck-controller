import type {AddressCheck, ClipListing, DeckSettings, Device, EditEntry, MediaInfo, ProxyStatus, SavedTimeline, SourcesTest, StripStatus, TransportInfo, NasBookmark, NasHost, AppSettings, NasCredential, NetworkDriveSource, NetworkDriveEntry} from './types';

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `${res.status} ${res.statusText}`);
  return data as T;
}

const q = (slot: number, file: string) => `slot=${slot}&file=${encodeURIComponent(file)}`;

export type DeviceInput = Partial<Pick<Device, 'name' | 'host' | 'port' | 'restPort' | 'ftp' | 'shares'>>;

export const api = {
  info: () => req<{ version: string; platform: string; ffmpeg: { ok: boolean; ffmpeg: string } }>('GET', '/api/info'),
  appSettings: () => req<AppSettings>('GET', '/api/settings'),
  updateAppSettings: (patch: Partial<AppSettings>) => req<AppSettings & { restartRequired: boolean }>('PATCH', '/api/settings', patch),

  credentials: () => req<NasCredential[]>('GET', '/api/credentials'),
  createCredential: (label: string, username: string, password?: string, path?: string) =>
    req<NasCredential>('POST', '/api/credentials', { label, username, password, path }),
  updateCredential: (id: string, patch: { label?: string; username?: string; password?: string; path?: string }) =>
    req<NasCredential>('PATCH', `/api/credentials/${id}`, patch),
  deleteCredential: (id: string) => req<void>('DELETE', `/api/credentials/${id}`),
  testCredential: (id: string) => req<{ ok: boolean; message: string; entries?: { name: string; isDir: boolean }[] }>('POST', `/api/credentials/${id}/test`),
  createDevice: (d: DeviceInput) => req<Device>('POST', '/api/devices', d),
  createTestDevice: (name?: string) => req<Device>('POST', '/api/devices/test', { name }),
  updateDevice: (id: string, d: DeviceInput) => req<Device>('PATCH', `/api/devices/${id}`, d),
  deleteDevice: (id: string) => req<void>('DELETE', `/api/devices/${id}`),
  refresh: (id: string) => req<unknown>('POST', `/api/devices/${id}/refresh`),
  testSources: (id: string) => req<SourcesTest>('GET', `/api/devices/${id}/sources/test`),
  networkDriveSources: (id: string) => req<NetworkDriveSource[]>('GET', `/api/devices/${id}/network-drives/sources`),
  browseNetworkDrive: (id: string, key: string, subPath?: string) =>
    req<{ ok: boolean; message: string; path?: string; entries?: NetworkDriveEntry[] }>('POST', `/api/devices/${id}/network-drives/browse`, { key, subPath }),
  networkThumbUrl: (id: string, key: string, relPath: string) =>
    `/api/devices/${id}/network-drives/thumb?key=${encodeURIComponent(key)}&path=${encodeURIComponent(relPath)}`,

  command: (id: string, command: string, params?: Record<string, string | number | boolean>) =>
    req<{ code: number; text: string }>('POST', `/api/devices/${id}/command`, { command, params }),
  settings: (id: string) => req<DeckSettings>('GET', `/api/devices/${id}/settings`),
  setSetting: (id: string, settingId: string, value: unknown) => req<DeckSettings>('POST', `/api/devices/${id}/settings`, { id: settingId, value }),
  action: (id: string, action: string, body?: Record<string, unknown>) => req<{ ok: boolean }>('POST', `/api/devices/${id}/actions/${action}`, body ?? {}),
  probe: (host: string, port?: number) => req<AddressCheck>('POST', '/api/probe', { host, port }),
  setEdit: (id: string, entries: EditEntry[]) => req<EditEntry[]>('PUT', `/api/devices/${id}/edit`, { entries }),

  timelines: (id: string) => req<SavedTimeline[]>('GET', `/api/devices/${id}/timelines`),
  saveTimeline: (id: string, name: string, entries?: EditEntry[]) => req<SavedTimeline>('POST', `/api/devices/${id}/timelines`, { name, entries }),
  renameTimeline: (tid: string, name: string) => req<SavedTimeline>('PATCH', `/api/timelines/${tid}`, { name }),
  overwriteTimeline: (tid: string, entries: EditEntry[]) => req<SavedTimeline>('PATCH', `/api/timelines/${tid}`, { entries }),
  deleteTimeline: (tid: string) => req<void>('DELETE', `/api/timelines/${tid}`),
  loadTimeline: (tid: string) => req<EditEntry[]>('POST', `/api/timelines/${tid}/load`),
  instantReplay: (sourceId: string, body: { seconds: number; targetId: string; mode?: 'append' | 'replace' }) =>
    req<{ source: { file: string; frames: number; fps: number }; inFrames: number; outFrames: number; edit: EditEntry[] }>('POST', `/api/devices/${sourceId}/instant-replay`, body),
  connectShare: (id: string, shareId: string) => req<{ ok: boolean; message: string }>('POST', `/api/devices/${id}/sources/${shareId}/connect`),

  nasBookmarks: (id: string) => req<NasBookmark[]>('GET', `/api/devices/${id}/nas/bookmarks`),
  addNasBookmark: (id: string, url: string, username?: string, password?: string) =>
    req<NasBookmark[]>('POST', `/api/devices/${id}/nas/bookmarks`, { url, username, password }),
  setNasBookmarkCredentials: (id: string, url: string, username?: string, password?: string) =>
    req<NasBookmark[]>('PUT', `/api/devices/${id}/nas/bookmarks`, { url, username, password }),
  removeNasBookmark: (id: string, url: string) => req<NasBookmark[]>('POST', `/api/devices/${id}/nas/bookmarks/remove`, { url }),
  nasSelected: (id: string) => req<{ url: string | null }>('GET', `/api/devices/${id}/nas/selected`),
  selectNas: (id: string, url: string | null) => req<{ url: string | null }>('POST', `/api/devices/${id}/nas/select`, { url }),
  nasDiscover: (id: string) => req<NasHost[]>('GET', `/api/devices/${id}/nas/discovered`),

  originalUrl: (id: string, slot: number, file: string): string | null => `/api/devices/${id}/media/original?${q(slot, file)}`,
  liveUrl: (id: string, slot: number, file: string, seconds: number): string | null =>
    `/api/devices/${id}/media/live?${q(slot, file)}&t=${seconds.toFixed(3)}`,
  clips: (id: string) => req<ClipListing[]>('GET', `/api/devices/${id}/clips`),
  load: (id: string, body: { slotId: number; file: string; frame: number; play?: boolean; singleClip?: boolean }) =>
    req<TransportInfo>('POST', `/api/devices/${id}/load`, body),

  mediaInfo: (id: string, slot: number, file: string) => req<MediaInfo>('GET', `/api/devices/${id}/media/info?${q(slot, file)}`),
  strip: (id: string, slot: number, file: string) => req<StripStatus>('GET', `/api/devices/${id}/media/strip?${q(slot, file)}`),
  startProxy: (id: string, slot: number, file: string) => req<ProxyStatus>('POST', `/api/devices/${id}/media/proxy`, { slot, file }),
  cancelProxy: (key: string) => req<void>('DELETE', `/api/media/proxy/${key}`),

  thumbUrl: (id: string, slot: number, file: string) => `/api/devices/${id}/media/thumb?${q(slot, file)}`,
  frameUrl: (id: string, slot: number, file: string, frame: number, h: number) =>
    `/api/devices/${id}/media/frame?${q(slot, file)}&frame=${frame}&h=${h}`,
  stripTileUrl: (key: string, i: number) => `/api/media/strip/${key}/${i}`,
  proxyUrl: (key: string) => `/api/media/proxy/${key}/video.mp4`,
  downloadUrl: (id: string, slot: number, file: string): string | null => `/api/devices/${id}/media/download?${q(slot, file)}`,
};

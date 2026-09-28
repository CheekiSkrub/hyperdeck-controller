import type { AddressCheck, ClipListing, DeckSettings, Device, EditEntry, MediaInfo, ProxyStatus, SourcesTest, StripStatus, TransportInfo } from './types';

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
  createDevice: (d: DeviceInput) => req<Device>('POST', '/api/devices', d),
  createTestDevice: (name?: string) => req<Device>('POST', '/api/devices/test', { name }),
  updateDevice: (id: string, d: DeviceInput) => req<Device>('PATCH', `/api/devices/${id}`, d),
  deleteDevice: (id: string) => req<void>('DELETE', `/api/devices/${id}`),
  refresh: (id: string) => req<unknown>('POST', `/api/devices/${id}/refresh`),
  testSources: (id: string) => req<SourcesTest>('GET', `/api/devices/${id}/sources/test`),

  command: (id: string, command: string, params?: Record<string, string | number | boolean>) =>
    req<{ code: number; text: string }>('POST', `/api/devices/${id}/command`, { command, params }),
  settings: (id: string) => req<DeckSettings>('GET', `/api/devices/${id}/settings`),
  setSetting: (id: string, settingId: string, value: unknown) => req<DeckSettings>('POST', `/api/devices/${id}/settings`, { id: settingId, value }),
  action: (id: string, action: string, body?: Record<string, unknown>) => req<{ ok: boolean }>('POST', `/api/devices/${id}/actions/${action}`, body ?? {}),
  probe: (host: string, port?: number) => req<AddressCheck>('POST', '/api/probe', { host, port }),
  setEdit: (id: string, entries: EditEntry[]) => req<EditEntry[]>('PUT', `/api/devices/${id}/edit`, { entries }),
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

import { useEffect, useSyncExternalStore } from 'react';
import type { Device, DeviceState } from './types';

/**
 * Live device list kept in sync over the server WebSocket. Media events
 * (filmstrip tiles, proxy progress) are fanned out to subscribers.
 */
type Listener = () => void;
type MediaEvent =
  | { type: 'strip'; deviceId: string; key: string; index: number; done?: boolean }
  | { type: 'proxy'; deviceId: string; key: string; state: string; progress: number; error?: string };

/** Shown across the top of the panel; set only in the browser demo build. */
export const DEMO_BANNER: string | null = null;

let devices: Device[] = [];
let connected = false;
const listeners = new Set<Listener>();
const mediaListeners = new Set<(e: MediaEvent) => void>();
let ws: WebSocket | null = null;
let started = false;

function emit() {
  for (const l of listeners) l();
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    connected = true;
    emit();
  };
  ws.onclose = () => {
    connected = false;
    emit();
    setTimeout(connect, 1500);
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'devices') {
      devices = msg.devices;
      emit();
    } else if (msg.type === 'state') {
      devices = devices.map((d) => (d.id === msg.id ? { ...d, state: msg.state as DeviceState } : d));
      emit();
    } else if (msg.type === 'strip' || msg.type === 'proxy') {
      for (const l of mediaListeners) l(msg);
    }
  };
}

function subscribe(l: Listener) {
  if (!started) {
    started = true;
    connect();
  }
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useDevices(): Device[] {
  return useSyncExternalStore(subscribe, () => devices);
}

export function useServerConnected(): boolean {
  return useSyncExternalStore(subscribe, () => connected);
}

export function useMediaEvents(fn: (e: MediaEvent) => void, deps: unknown[]) {
  useEffect(() => {
    mediaListeners.add(fn);
    return () => {
      mediaListeners.delete(fn);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/** Demo replacement for lib/store.ts, fed by the in-browser simulator. */
import { useEffect, useSyncExternalStore } from 'react';
import type { Device } from '../lib/types';
import * as sim from './sim';

export const DEMO_BANNER: string | null =
  'Browser demo: these HyperDecks are simulated, so you can try every control safely. The real app talks to decks over the network and reads clips via FTP or your NAS.';

type MediaEvent =
  | { type: 'strip'; deviceId: string; key: string; index: number; done?: boolean }
  | { type: 'proxy'; deviceId: string; key: string; state: string; progress: number; error?: string };

const mediaListeners = new Set<(e: MediaEvent) => void>();
export function emitMedia(e: MediaEvent) {
  for (const l of mediaListeners) l(e);
}

export function useDevices(): Device[] {
  return useSyncExternalStore(sim.onChange, sim.devices);
}

export function useServerConnected(): boolean {
  return true;
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

import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { ClipLibrary } from './types';

export interface Library {
  lib: ClipLibrary;
  setTags: (file: string, tags: string[]) => Promise<void>;
  createGroup: (name: string, files?: string[]) => Promise<void>;
  renameGroup: (id: string, name: string) => Promise<void>;
  addToGroup: (id: string, files: string[]) => Promise<void>;
  removeFromGroup: (id: string, files: string[]) => Promise<void>;
  deleteGroup: (id: string) => Promise<void>;
}

/** Tags and groups for one deck's clips (stored on the server, shared by everyone using it). */
export function useLibrary(deviceId: string, notify: (m: string) => void): Library {
  const [lib, setLib] = useState<ClipLibrary>({ tags: {}, groups: [] });

  useEffect(() => {
    api.library(deviceId).then(setLib).catch(() => {});
  }, [deviceId]);

  const run = useCallback((p: Promise<ClipLibrary>) => p.then(setLib).catch((e) => notify((e as Error).message)), [notify]);

  return {
    lib,
    setTags: (file, tags) => run(api.setTags(deviceId, file, tags)),
    createGroup: (name, files) => run(api.createGroup(deviceId, name, files)),
    renameGroup: (id, name) => run(api.updateGroup(deviceId, id, { name })),
    addToGroup: (id, files) => run(api.updateGroup(deviceId, id, { add: files })),
    removeFromGroup: (id, files) => run(api.updateGroup(deviceId, id, { remove: files })),
    deleteGroup: (id) => run(api.deleteGroup(deviceId, id)),
  };
}

import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { NasCredential } from '../lib/types';

/**
 * A small "fill from a saved login" dropdown, used anywhere a username/
 * password pair is entered for a NAS or share (device form share rows, deck
 * NAS bookmarks). Picking one copies its username/password into the caller's
 * fields via onPick — it doesn't keep a link to the saved credential.
 */
export function CredentialPicker({ onPick }: { onPick: (c: NasCredential) => void }) {
  const [list, setList] = useState<NasCredential[] | null>(null);

  useEffect(() => { api.credentials().then(setList).catch(() => setList([])); }, []);

  if (!list || list.length === 0) return null;

  return (
    <label className="cred-fill">
      <span>Fill from saved credentials</span>
      <select
        defaultValue=""
        onChange={(e) => {
          const c = list.find((x) => x.id === e.target.value);
          if (c) onPick(c);
          e.target.value = '';
        }}
      >
        <option value="" disabled>Choose a saved login…</option>
        {list.map((c) => <option key={c.id} value={c.id}>{c.label} ({c.username})</option>)}
      </select>
    </label>
  );
}

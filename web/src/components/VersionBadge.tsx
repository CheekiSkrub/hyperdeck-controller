/// <reference types="vite/client" />
import { useEffect, useState } from 'react';
import { WEB_BUILD } from '../buildInfo';
import { api } from '../lib/api';

/**
 * Sidebar footer showing which build the panel (web) and the server are running, so it's
 * obvious at a glance whether a change has actually been picked up. If the two came from
 * different commits (e.g. the Vite dev server or the server process wasn't restarted), it
 * says so rather than leaving you to guess.
 */
export function VersionBadge({ online }: { online: boolean }) {
  const [server, setServer] = useState<{ version: string; commit?: string; builtAt?: string } | null>(null);
  useEffect(() => {
    if (!online) return;
    api.info().then(setServer).catch(() => setServer(null));
  }, [online]);

  const strip = (v: string) => v.replace(/-dev$/, '');
  const mismatch = server !== null && server.commit !== undefined &&
    (server.commit !== WEB_BUILD.commit || strip(server.version) !== strip(WEB_BUILD.version));
  // A dev server ("-dev") handing out a built panel means we're on web/dist, not Vite — restarting
  // npm run dev won't change it, so point at the actual fix instead.
  const servedBuiltCopy = !import.meta.env.DEV && server !== null && server.version.endsWith('-dev');
  const fmt = (iso?: string) => (iso ? new Date(iso).toLocaleString() : 'unknown');

  return (
    <div className={`version-badge ${mismatch ? 'mismatch' : ''}`}>
      <div title={`Web panel built ${fmt(WEB_BUILD.builtAt)}`}>
        Panel <span className="mono">v{WEB_BUILD.version}</span> · <span className="mono">{WEB_BUILD.commit}</span>
      </div>
      <div title={server ? `Server started/built ${fmt(server.builtAt)}` : ''}>
        Server {server ? (
          <><span className="mono">v{server.version}</span> · <span className="mono">{server.commit ?? 'unknown'}</span></>
        ) : <span className="muted">—</span>}
      </div>
      {mismatch && (servedBuiltCopy ? (
        <div className="version-warn">
          This page is the server's saved copy of the panel (<code>web/dist</code>), which is out of date.
          Open the live panel on port 5173, or run <code>npm run build --workspace web</code>.
        </div>
      ) : (
        <div className="version-warn">Panel and server are on different builds — restart <code>npm run dev</code> and hard-refresh.</div>
      ))}
    </div>
  );
}

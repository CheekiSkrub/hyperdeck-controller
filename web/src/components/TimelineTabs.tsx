import { useEffect, useState } from 'react';
import type { Timelines } from '../lib/timelines';
import type { Device, SavedTimeline } from '../lib/types';

/**
 * One tab per timeline. The LIVE one is on the deck; the rest are staged running orders that can
 * be built up in advance and sent to the deck when it's their turn. Rename by double-click or the
 * right-click menu (which also has Send to deck and Delete).
 */
export function TimelineTabs({ device, timelines }: { device: Device; timelines: Timelines }) {
  const { list, active } = timelines;
  const [renaming, setRenaming] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const [menu, setMenu] = useState<{ x: number; y: number; t: SavedTimeline } | null>(null);
  const playing = ['play', 'forward', 'rewind', 'shuttle'].includes(device.state.transport?.status ?? '');

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    return () => { window.removeEventListener('click', close); window.removeEventListener('scroll', close, true); };
  }, [menu]);

  const startRename = (t: SavedTimeline) => { setRenaming(t.id); setValue(t.name); };
  const finishRename = () => {
    if (renaming && value.trim()) void timelines.rename(renaming, value.trim());
    setRenaming(null);
  };
  const send = (t: SavedTimeline) => {
    if (t.live) return;
    if (playing && !window.confirm(`The deck is playing. Replace what's on it with "${t.name}"?`)) return;
    void timelines.sendToDeck(t.id);
  };
  const remove = (t: SavedTimeline) => {
    if (window.confirm(`Delete "${t.name}"? Its clips stay on the deck's media.`)) void timelines.remove(t.id);
  };

  return (
    <div className="tl-tabs" role="tablist" aria-label="Timelines">
      {list.map((t) => (
        <div key={t.id} role="tab" aria-selected={t.id === active?.id}
          className={`tl-tab ${t.id === active?.id ? 'on' : ''} ${t.live ? 'live' : ''}`}
          onClick={() => timelines.setActive(t.id)}
          onDoubleClick={() => startRename(t)}
          onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, t }); }}
          title={t.live ? 'On the deck — edits change what the deck plays' : 'Staged — edits are saved, the deck is untouched until you send it'}>
          {renaming === t.id ? (
            <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} onBlur={finishRename}
              onKeyDown={(e) => { if (e.key === 'Enter') finishRename(); if (e.key === 'Escape') setRenaming(null); }}
              onClick={(e) => e.stopPropagation()} aria-label="Timeline name" />
          ) : (
            <span className="tl-tab-name">{t.name}</span>
          )}
          {t.live && <span className="badge live small">LIVE</span>}
          <span className="muted small">{(t.entries ?? []).length}</span>
          {!t.live && (
            <button className="tl-tab-x" aria-label={`Delete ${t.name}`} title="Delete this timeline"
              onClick={(e) => { e.stopPropagation(); remove(t); }}>×</button>
          )}
        </div>
      ))}
      <button className="btn small ghost tl-tab-add" onClick={() => void timelines.create()} title="New timeline">+ New timeline</button>
      <span className="spacer" />
      {active && !active.live && (
        <button className="btn small primary" onClick={() => send(active)} disabled={!active.entries.length || timelines.editor.busy}
          title="Replace the deck's timeline with this one">Send “{active.name}” to deck</button>
      )}

      {menu && (
        <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} role="menu" onClick={(e) => e.stopPropagation()}>
          <button role="menuitem" onClick={() => { setMenu(null); timelines.setActive(menu.t.id); startRename(menu.t); }}>Rename…</button>
          {!menu.t.live && (
            <button role="menuitem" onClick={() => { setMenu(null); send(menu.t); }} disabled={!menu.t.entries.length}>Send to deck</button>
          )}
          {!menu.t.live && (
            <>
              <hr />
              <button role="menuitem" className="danger" onClick={() => { setMenu(null); remove(menu.t); }}>Delete timeline</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

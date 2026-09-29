import { useState } from 'react';
import type { Timelines } from '../lib/timelines';
import type { Device } from '../lib/types';

/**
 * One tab per timeline. The LIVE one is on the deck; the rest are staged running orders that can
 * be built up in advance and sent to the deck when it's their turn. Double-click a name to rename.
 */
export function TimelineTabs({ device, timelines }: { device: Device; timelines: Timelines }) {
  const { list, active } = timelines;
  const [renaming, setRenaming] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const playing = ['play', 'forward', 'rewind', 'shuttle'].includes(device.state.transport?.status ?? '');

  const finishRename = () => {
    if (renaming && value.trim()) void timelines.rename(renaming, value.trim());
    setRenaming(null);
  };

  const send = () => {
    if (!active || active.live) return;
    if (playing && !window.confirm(`The deck is playing. Replace what's on it with "${active.name}"?`)) return;
    void timelines.sendToDeck(active.id);
  };

  return (
    <div className="tl-tabs" role="tablist" aria-label="Timelines">
      {list.map((t) => (
        <div key={t.id} role="tab" aria-selected={t.id === active?.id}
          className={`tl-tab ${t.id === active?.id ? 'on' : ''} ${t.live ? 'live' : ''}`}
          onClick={() => timelines.setActive(t.id)}
          onDoubleClick={() => { setRenaming(t.id); setValue(t.name); }}
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
              onClick={(e) => {
                e.stopPropagation();
                if (window.confirm(`Delete "${t.name}"? Its clips stay on the deck's media.`)) void timelines.remove(t.id);
              }}>×</button>
          )}
        </div>
      ))}
      <button className="btn small ghost tl-tab-add" onClick={() => void timelines.create()} title="New timeline">+ New timeline</button>
      <span className="spacer" />
      {active && !active.live && (
        <button className="btn small primary" onClick={send} disabled={!active.entries.length || timelines.editor.busy}
          title="Replace the deck's timeline with this one">Send “{active.name}” to deck</button>
      )}
    </div>
  );
}

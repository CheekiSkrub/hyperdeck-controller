import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import type { ClipListing, Device } from '../lib/types';

export function ClipBrowser({ device, onOpen, notify }: { device: Device; onOpen: (c: ClipListing) => void; notify: (m: string) => void }) {
  const [clips, setClips] = useState<ClipListing[]>([]);
  const [slot, setSlot] = useState<number | 'all'>('all');
  const [search, setSearch] = useState('');
  const s = device.state;

  // Re-fetch whenever the deck reports different media or timeline.
  const signature = useMemo(
    () => JSON.stringify([s.status, s.disks, s.timeline.map((c) => c.name), s.transport?.slotId, s.slots.map((x) => x.status)]),
    [s.status, s.disks, s.timeline, s.transport?.slotId, s.slots],
  );
  useEffect(() => {
    if (s.status !== 'connected') return;
    api.clips(device.id).then(setClips).catch((e) => notify(e.message));
  }, [device.id, signature]);

  const slots = useMemo(() => [...new Map(clips.map((c) => [c.slotId, c.slotLabel])).entries()], [clips]);
  const shown = clips.filter((c) => (slot === 'all' || c.slotId === slot) && c.file.toLowerCase().includes(search.toLowerCase()));

  return (
    <section className="card clips">
      <div className="clips-head">
        <h2>Clips</h2>
        <div className="seg" role="group" aria-label="Filter by media">
          <button className={slot === 'all' ? 'on' : ''} onClick={() => setSlot('all')}>All</button>
          {slots.map(([id, label]) => (
            <button key={id} className={slot === id ? 'on' : ''} onClick={() => setSlot(id)}>{label}</button>
          ))}
        </div>
        <input className="search" placeholder="Search clips" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      {s.status !== 'connected' && clips.length === 0 ? (
        <p className="muted">Connect to the HyperDeck to browse its clips.</p>
      ) : shown.length === 0 ? (
        <p className="muted">No clips{search ? ' match your search' : ' on mounted media'}.</p>
      ) : (
        <div className="clip-grid">
          {shown.map((c) => (
            <ClipCard key={`${c.slotId}/${c.file}`} device={device} clip={c} onOpen={() => onOpen(c)} />
          ))}
        </div>
      )}
    </section>
  );
}

function ClipCard({ device, clip, onOpen }: { device: Device; clip: ClipListing; onOpen: () => void }) {
  const [failed, setFailed] = useState(false);
  const current = device.state.transport?.slotId === clip.slotId && clip.timelineId !== null && device.state.transport?.clipId === clip.timelineId;
  return (
    <button className={`clip-card ${current ? 'current' : ''}`} onClick={onOpen} title={`Open ${clip.file}`}>
      <div className="thumb">
        {failed ? (
          <span className="thumb-fail">No preview{clip.isNetwork ? ' — map network share' : ''}</span>
        ) : (
          <img loading="lazy" src={api.thumbUrl(device.id, clip.slotId, clip.file)} alt="" onError={() => setFailed(true)} />
        )}
        <span className="duration mono">{clip.duration}</span>
        {clip.isNetwork && <span className="tag net">NAS</span>}
        {current && <span className="tag live">ON DECK</span>}
      </div>
      <div className="clip-name">{clip.file}</div>
      <div className="clip-meta muted small">{clip.slotLabel} · {clip.videoFormat} · {clip.fileFormat}</div>
    </button>
  );
}

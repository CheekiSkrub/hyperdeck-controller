# Architecture

```
 Browser (React panel)  ──HTTP /api──►  Server (Node, Fastify)  ──TCP 9993──►  HyperDeck
        ▲                                   │   │                               ▲
        └────────── WebSocket /ws ◄─────────┘   │  ffmpeg ─► http://127.0.0.1/internal/ftp ─► FTP :21 ─┘
                                                │  ffmpeg ─► share path (UNC / mount) ─► NAS the deck records to
                                                └─ cache dir (thumbs, filmstrips, frames, proxies)
```

## Server (`server/src`)

| Module | Role |
|---|---|
| `hyperdeck/protocol.ts` | Framing and parsing for the Ethernet protocol: single-line and multi-line responses, 5xx async notifications, `transport info`, `slot info`, `disk list`, `clips get` v1/v2/v3, and timecode maths including drop-frame. |
| `hyperdeck/client.ts` | One persistent connection per deck. It serialises commands (the deck answers one at a time, in order), enables notifications, merges 5xx updates into cached state, pings every 10 s, and reconnects with backoff. |
| `devices/store.ts` | Device list stored as JSON in the OS config directory. Holds name, IP, control port, FTP credentials and network share mappings. |
| `hyperdeck/rest.ts` | HyperDeck REST API client (`http://deck/control/api/v1`, firmware 8.x+). It supplies what the Ethernet protocol can't list: supported codecs and video formats, audio record formats, input sources and monitoring overlays. |
| `devices/edit.ts` | The deck timeline as an edit list (`file`, frame `in`, exclusive `out`). Edits are applied by running `clips clear` and then `clips add` for each entry (`frame in`/`frame out` for slices). |
| `devices/settings.ts` | The deck's setup menu as generic setting descriptors (Record, Video, Audio, Timecode, Playback, System, Monitoring). It reads from `configuration`, `play option`, `play on startup`, `dynamic range` and `remote`, plus REST, and writes each setting back through the source it came from. It also handles identify, reboot and format (prepare, then confirm with a token). |
| `devices/manager.ts` | Wires store to clients, builds the clip listing, keeps an allow-list of protocol commands the panel may send, and runs the `loadClip` cue sequence. |
| `media/locator.ts` | Works out where a clip can be read. It indexes the deck's FTP tree (`ssd1`, `sd2`, `usb/<drive>` and so on) and each mapped share. Network slots check shares first, internal media checks FTP first. |
| `media/ftpBridge.ts` | Localhost HTTP endpoint that turns Range requests into FTP `REST`+`RETR`. ffmpeg's own `ftp://` doesn't decode `%20` (so names with spaces fail) and has poor timeouts. The bridge also serves "Download original". |
| `media/ffmpeg.ts` | ffprobe, exact-frame JPEG grabs (`-ss` before `-i`, so only the bytes needed are read), and the H.264 proxy transcode with progress. |
| `media/service.ts` | Disk cache keyed by device + path + size + mtime, so a file that is still recording gets a new key. A per-device priority semaphore lets exact frames jump ahead of filmstrip work. Proxy jobs have their own queue. Cache eviction is LRU. |
| `routes/api.ts` | REST API (below). |
| `static.ts` | Serves the panel, embedded as a SEA asset in release builds or read from `web/dist` in development. |

### Cueing a file at a frame (`POST /api/devices/:id/load`)

1. Refuse if the deck is recording. Leave input (preview) mode if needed.
2. Run `slot select: slot id: N` if the file is on a different slot. The deck rebuilds its timeline from that media.
3. Run `clips get` (v3 where supported) and match the file by name. If it's missing, run `clips add: name: <file>`.
4. Run `goto: clip id: <id>`, then `goto: clip: +<frame>` (relative from the clip's first frame).
5. Optionally run `playrange set: clip id` (single clip) and `play`.

The frame number comes from the browser scrubber, which counts frames in the file using ffprobe's frame rate. Exact frames are extracted with `-ss (frame − 0.25)/fps`, and the result has been checked against burnt-in frame counters for ProRes over FTP and long-GOP H.264.

### Timeline editing

The panel's timeline is an editor track. You can drag clips in from the clip browser, drag blocks to reorder them, drag block edges to trim, and right-click to split, duplicate, restore the full clip or remove it. `S` splits at the playhead and `Delete` removes the selected block. In the viewer, `I`/`O` set in and out points and *Add section to timeline* appends that slice.

The protocol can append a portion (`clips add: frame in: frame out: name:`) but can't insert one at a position. Every edit therefore rebuilds the deck timeline in order. It's a handful of commands, and it keeps the panel and the deck exactly in step. The deck timeline can only use clips from the active slot.

`clips get` v2/v3 fields (`clipInT clipDuration inT outT`) aren't defined in Blackmagic's docs. `editFromState` handles both readings (in/out as clip timecodes, or as timeline positions) and trusts the last edit list it applied while the deck still matches it. `DECK_FRAME_OUT_INCLUSIVE` in `edit.ts` flips the frame-out convention if slices come out one frame long on hardware.

### Browser playback

- **Proxy**: when a proxy exists, the viewer plays it.
- **Original file**: when the browser can decode the clip's codec (H.264 or H.265; ProRes in Safari), it plays `/media/original` directly with Range requests. From an SMB share this is just a local file read on the server. From FTP it goes through the bridge.
- **Live preview**: for everything else (ProRes and DNx in Chrome/Edge/Firefox), ▶ starts `/media/live`. The server transcodes to fragmented H.264 from the current frame, starting immediately and at full LAN speed from a share. Scrubbing leaves live mode, and ▶ restarts from the new frame. The server allows at most 4 live previews at once.

### Timecode clock

5xx `transport`, `display timecode` and `timeline position` notifications take a fast path. The server sends only the transport object over the WebSocket, at most every 15 ms. Slot, clip and disk changes still go out as debounced full state. The panel's `LiveTimecode` runs a `requestAnimationFrame` clock while the deck is moving. It extrapolates from the last report at the current speed, capped at 0.5 s ahead, and resyncs on every update. It never steps backwards on jitter, so the display ticks every frame even when network updates are uneven.

### Deck settings and IP changes

The *Deck settings* tab shows the deck's setup menu. Each change is applied immediately and then re-read from the deck. Blackmagic doesn't expose the deck's own network settings (IP, DHCP) over either API, so those still have to be changed on the deck or with HyperDeck Setup. When you change a device's IP in the panel, the server first tries a protocol handshake at the new address and checks it against its own subnets. If nothing answers there, or the address is off-subnet, the form warns that the panel will lose contact and asks you to confirm.

### Scrubbing

- **Filmstrip**: 12–120 tiles depending on duration, generated in bisection order (start, middle, quarters…) so coverage stays even while it fills. Tiles are pushed over the WebSocket as they're ready.
- **Exact frame**: requested (with a debounce during drag) at the viewer's display resolution. The nearest tile shows immediately, then the exact frame replaces it.
- **Proxy (optional)**: 540p H.264 with a 12-frame GOP and faststart. When one is ready the viewer switches to a `<video>` element for smooth scrubbing and playback. If the browser can't decode H.264 (some Linux Chromium builds), the viewer falls back to stills.

### Network storage

The HyperDeck FTP server only exposes internal media. For decks recording to an SMB/AFP share:

- The server itself must be able to read the share. On Windows use a UNC path (`\\nas\Recordings`), which needs no drive mapping but the service account needs access. On macOS mount it in Finder (`/Volumes/Recordings`). On Linux mount it with cifs.
- Each device has a list of share mappings (`label`, optional HyperDeck `url`, `localPath`). If the deck reports a selected NAS URL (`nas selected`) that matches a mapping's URL, that mapping is tried first.
- A slot counts as network storage when its slot or device name mentions nas/network/smb, or when a NAS is selected and the slot number is higher than the physical slot count.

## API

| Method | Path | |
|---|---|---|
| GET/POST | `/api/devices` | list / create `{name, host, port?, ftp?, shares?}` |
| GET/PATCH/DELETE | `/api/devices/:id` | read / update / remove |
| POST | `/api/devices/:id/command` | `{command, params}`, from the allow-list in `manager.ts` |
| POST | `/api/devices/:id/refresh` | re-query everything |
| GET | `/api/devices/:id/clips` | files on all mounted slots |
| POST | `/api/devices/:id/load` | `{slotId, file, frame, play?, singleClip?}` |
| GET | `/api/devices/:id/sources/test` | FTP and share diagnostics |
| PUT | `/api/devices/:id/edit` | `{entries: [{file, in, out}]}`, rebuilds the deck timeline |
| GET/POST | `/api/devices/:id/settings` | read the setup menu / `{id, value}` to change one setting |
| POST | `/api/devices/:id/actions/{identify,reboot,format}` | maintenance |
| POST | `/api/probe` | `{host, port}`: can the server reach a deck there, and is it on a local subnet? |
| GET | `/api/devices/:id/media/{original,live}?slot=&file=[&t=]` | browser playback |
| GET | `/api/devices/:id/media/{info,thumb,frame,strip,download}?slot=&file=` | media |
| POST | `/api/devices/:id/media/proxy` | start a proxy transcode |
| GET | `/api/media/strip/:key/:i`, `/api/media/proxy/:key/video.mp4` | cached assets |
| WS | `/ws` | `devices`, `state`, `strip`, `proxy` events |

## Known gaps / next steps

- **Security**: the panel has no authentication and binds to all interfaces by default. It should get at least a shared password, or bind to a chosen interface, before going on untrusted networks.
- **HyperDeck secure access**: firmware can require `authenticate:` (multi-line). This isn't implemented yet.
- **Real-hardware checks**: response details that differ by firmware still need checking on real decks. That includes the `clips get` v2 field meanings and whether frame out is inclusive, the `configuration` value strings for each model, and the REST JSON shapes for codec, audio and video-format lists. That covers how network storage shows up in `slot info`, the `nas selected` response, and the `clips get` v3 fields. The parsers are tolerant, but the NAS slot heuristic in `locator.ts` should be confirmed on a Studio HD Pro / Extreme with NAS recording.
- **Desktop integration**: a tray icon and run-at-login / Windows service install are not built yet.
- **ffmpeg licensing**: the default bundled builds (ffmpeg-static) are GPL. For commercial distribution, swap in an LGPL build with `FFMPEG_DIR` and ship a source offer.

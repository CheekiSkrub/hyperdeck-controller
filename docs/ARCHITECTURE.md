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
| GET | `/api/devices/:id/media/{info,thumb,frame,strip,download}?slot=&file=` | media |
| POST | `/api/devices/:id/media/proxy` | start a proxy transcode |
| GET | `/api/media/strip/:key/:i`, `/api/media/proxy/:key/video.mp4` | cached assets |
| WS | `/ws` | `devices`, `state`, `strip`, `proxy` events |

## Known gaps / next steps

- **Security**: the panel has no authentication and binds to all interfaces by default. It should get at least a shared password, or bind to a chosen interface, before going on untrusted networks.
- **HyperDeck secure access**: firmware can require `authenticate:` (multi-line). This isn't implemented yet.
- **Real-hardware checks**: response details that differ by firmware still need checking on real decks. That covers how network storage shows up in `slot info`, the `nas selected` response, and the `clips get` v3 fields. The parsers are tolerant, but the NAS slot heuristic in `locator.ts` should be confirmed on a Studio HD Pro / Extreme with NAS recording.
- **Desktop integration**: a tray icon and run-at-login / Windows service install are not built yet.
- **ffmpeg licensing**: the default bundled builds (ffmpeg-static) are GPL. For commercial distribution, swap in an LGPL build with `FFMPEG_DIR` and ship a source offer.

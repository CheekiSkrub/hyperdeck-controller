# HyperDeck Controller

A cross-platform server (Windows / macOS / Linux) that controls Blackmagic HyperDeck recorders and serves a browser-based control panel to anyone on the network.

- **Devices**: add, edit and remove HyperDecks by name and IP address. Connections are kept open and reconnect automatically.
- **Full transport control** over the HyperDeck Ethernet Protocol (TCP 9993): play, stop, record (with a clip name), frame step, clip skip, fast forward and rewind, shuttle, loop, single clip, input and playback modes, slot select, timeline jump, and live timecode through protocol notifications.
- **Clip browser** with thumbnails for every clip on every mounted slot.
- **Scrubbing in the browser**: a progressive filmstrip gives instant coarse scrubbing, and the exact frame loads when you stop. Frames are read straight from the deck's FTP without downloading the file. An optional H.264 proxy gives smooth video scrubbing and playback in the browser.
- **Cue at the scrubbed frame**: *Cue on HyperDeck* selects the right slot, puts the clip on the timeline, jumps to the clip and steps to the exact frame. *Cue & Play* also rolls it.
- **Network storage**: when a deck records to an SMB/AFP share, its FTP can't see those clips, so the server reads the share directly using a per-device mapping (UNC path on Windows, mount point on macOS/Linux).

Supported: HyperDeck Studio (current models, firmware 8.x+), HyperDeck Extreme 4K/8K HDR, and HyperDeck Shuttle HD.

## Quick start (development)

```bash
npm install
npm run dev:mock          # optional: mock HyperDeck on :9993 + FTP on :2121 with test clips
npm run dev               # server on :8080, Vite panel on :5173 (proxied)
```

Open http://localhost:5173. For the mock, add a device with IP `127.0.0.1` and set the FTP port to `2121` under *Media access & advanced*. To try network storage, add a share whose *Path on this server* is the `tools/.mock-media/nas` folder the mock prints.

Requires Node 22.12+ and ffmpeg/ffprobe on PATH for development. Release builds bundle ffmpeg.

## Build a release

```bash
npm run package           # -> release/hyperdeck-controller-<ver>-<os>-<arch>/
```

This produces a Node single executable with the web panel embedded, plus `ffmpeg`/`ffprobe` beside it. The GitHub Actions workflow (`.github/workflows/release.yml`) builds Windows x64, macOS arm64/x64 and Linux x64, signs each one (Authenticode, Developer ID with notarization, GPG), and drafts a GitHub release when you push a `v*` tag. See [docs/SIGNING.md](docs/SIGNING.md).

## Layout

```
server/   Fastify API + WebSocket, HyperDeck protocol client, media pipeline (ffmpeg)
web/      React control panel (Vite)
tools/    mock HyperDeck (protocol + FTP) for development and tests
scripts/  single-executable packaging, macOS entitlements
docs/     architecture, signing, end-user README
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the pieces fit together.

## Tests

```bash
npm test                  # protocol parser, timecode, media helpers
npm run typecheck
```

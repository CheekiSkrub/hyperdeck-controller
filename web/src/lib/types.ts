// Mirrors of the server's JSON shapes.

export interface TransportInfo {
  status: 'preview' | 'stopped' | 'play' | 'forward' | 'rewind' | 'jog' | 'shuttle' | 'record';
  speed: number;
  slotId: number | null;
  slotName?: string;
  deviceName?: string;
  clipId: number | null;
  singleClip: boolean;
  displayTimecode: string;
  timecode: string;
  videoFormat: string;
  loop: boolean;
  timeline?: number;
  inputVideoFormat?: string;
  referenceLocked?: boolean;
}

export interface SlotInfo {
  slotId: number;
  slotName?: string;
  deviceName?: string;
  status: string;
  volumeName?: string;
  recordingTime?: number;
  videoFormat?: string;
  blocked?: boolean;
  remainingSize?: number;
  totalSize?: number;
}

/** Space on the mapped NAS share, measured by the server (see /api/devices/:id/nas/space). */
export interface ShareSpace {
  shareId: string;
  label: string;
  path: string;
  total: number;
  free: number;
}

export interface TimelineClip {
  id: number;
  name: string;
  startTimecode: string;
  duration: string;
  inTimecode?: string;
  outTimecode?: string;
}

export interface DeviceState {
  status: 'disconnected' | 'connecting' | 'connected';
  lastError?: string;
  info: { protocolVersion?: string; model?: string; uniqueId?: string; slotCount: number; softwareVersion?: string; name?: string } | null;
  transport: TransportInfo | null;
  slots: SlotInfo[];
  disks: Record<number, { index: number; name: string; fileFormat: string; videoFormat: string; duration: string }[]>;
  timeline: TimelineClip[];
  remote: { enabled: boolean; override: boolean } | null;
  nasUrl: string | null;
  /** The deck's timeline as an edit list. */
  edit: EditEntry[];
}

/** One timeline entry: frames [in, out) of a file on the active slot. */
export interface EditEntry {
  file: string;
  in: number;
  out: number;
  /** Total frames in the file. */
  frames: number;
  /** Deck didn't report enough to know the exact in point. */
  approx?: boolean;
}

export interface ShareMapping {
  id?: string;
  label: string;
  url?: string;
  localPath: string;
  /** This server's own credentials for connecting to the share (separate from the deck's NAS bookmark credentials). */
  username?: string;
  password?: string;
}

/** The deck's own saved network-storage destination (Ethernet protocol `nas`, or REST `/media/nas/...`). */
export interface NasBookmark {
  url: string;
}

export interface NasHost {
  hostName: string;
  friendlyName?: string;
  ip: string;
}

export interface Device {
  id: string;
  name: string;
  host: string;
  port: number;
  restPort: number;
  ftp: { enabled: boolean; port: number; user: string; password: string };
  shares: ShareMapping[];
  createdAt: string;
  state: DeviceState;
  /** A simulated HyperDeck created from "+ Add test HyperDeck", not a real device. */
  test?: boolean;
}

export interface ClipListing {
  slotId: number;
  slotLabel: string;
  isNetwork: boolean;
  index: number;
  file: string;
  fileFormat: string;
  videoFormat: string;
  duration: string;
  fps: number | null;
  frames: number | null;
  timelineId: number | null;
}

export interface ProbeResult {
  duration: number;
  startTime: number;
  fps: number;
  frames: number;
  width: number;
  height: number;
  codec: string;
  profile?: string;
  timecode?: string;
  audioChannels: number;
  size?: number;
}

export interface ProxyStatus {
  key: string;
  state: 'none' | 'queued' | 'running' | 'ready' | 'error';
  progress: number;
  error?: string;
}

export interface MediaInfo {
  key: string;
  source: { kind: 'ftp' | 'share'; display: string; size?: number };
  probe: ProbeResult;
  proxy: ProxyStatus;
}

export interface StripStatus {
  key: string;
  count: number;
  duration: number;
  fps: number;
  times: number[];
  ready: boolean[];
  done: boolean;
}

export interface SourcesTest {
  ftp: { ok: boolean; message: string; mediaFiles?: number; folders?: string[] };
  shares: { id: string; label: string; ok: boolean; message: string }[];
  nasUrl: string | null;
}

export interface DeckSetting {
  id: string;
  group: string;
  label: string;
  type: 'select' | 'bool' | 'text' | 'number' | 'timecode' | 'info';
  value: string | number | boolean | null;
  options?: { value: string; label: string }[];
  help?: string;
  readOnly?: boolean;
}

export interface DeckSettings {
  rest: boolean;
  settings: DeckSetting[];
  errors: string[];
}

export interface SavedTimeline {
  id: string;
  deviceId: string;
  name: string;
  entries: EditEntry[];
  createdAt: string;
  updatedAt: string;
}

export interface AppSettings {
  port: number;
  host: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  cacheDir: string;
  maxCacheGB: number;
  mediaConcurrency: number;
  proxyHeight: number;
  openBrowser: boolean;
}

/** A saved NAS/SMB login, reusable when filling in a device's share mapping or NAS bookmark. */
export interface NasCredential {
  id: string;
  label: string;
  username: string;
  password: string;
  /** UNC path or mount point this login connects to — lets "Test" verify it and list what's there. */
  path?: string;
  createdAt: string;
  updatedAt: string;
}

export interface NetworkDriveSource {
  key: string;
  label: string;
}

export interface NetworkDriveEntry {
  name: string;
  isDir: boolean;
  size?: number;
  modifiedAt?: string;
}

export interface AddressCheck {
  reachable: boolean;
  model?: string;
  error?: string;
  sameSubnet: boolean;
  serverAddresses: string[];
}

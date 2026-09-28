/**
 * Minimal client for the HyperDeck REST API (firmware 8.x+, HyperDeck Studio,
 * Extreme, Shuttle HD): http://<deck>/control/api/v1/...
 *
 * The Ethernet protocol covers transport and most of the setup menu; REST adds
 * the things it can't enumerate: the list of codecs and video formats the
 * deck supports, audio record formats, monitoring overlays and NAS bookmarks.
 */
export class RestError extends Error {
  constructor(message: string, public readonly status: number) { super(message); }
}

export class HyperDeckRest {
  constructor(private host: string, private port = 80) {}

  setAddress(host: string, port = 80) {
    this.host = host;
    this.port = port;
  }

  private url(path: string) {
    const h = this.host.includes(':') && !this.host.startsWith('[') ? `[${this.host}]` : this.host;
    return `http://${h}${this.port === 80 ? '' : `:${this.port}`}/control/api/v1${path}`;
  }

  async get<T = unknown>(path: string, timeoutMs = 3000): Promise<T> {
    const res = await fetch(this.url(path), { signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 204) return undefined as T;
    if (!res.ok) throw new RestError(`GET ${path}: ${res.status}`, res.status);
    return res.json() as Promise<T>;
  }

  async send(method: 'PUT' | 'POST' | 'DELETE', path: string, body?: unknown, timeoutMs = 5000): Promise<void> {
    const res = await fetch(this.url(path), {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new RestError(`${method} ${path}: ${res.status}${text ? ` ${text.slice(0, 200)}` : ''}`, res.status);
    }
  }

  /** True when the deck answers REST (it may be disabled in the deck's network settings). */
  async available(): Promise<boolean> {
    try {
      await this.get('/system/product', 2000);
      return true;
    } catch {
      return false;
    }
  }
}

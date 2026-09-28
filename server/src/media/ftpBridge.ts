import crypto from 'node:crypto';
import { Writable } from 'node:stream';
import { Client as FtpClient } from 'basic-ftp';
import type { FastifyInstance } from 'fastify';
import type { Device } from '../devices/store.js';

/**
 * HTTP -> FTP range bridge.
 *
 * ffmpeg's built-in ftp:// protocol does not percent-decode paths (so clip names
 * with spaces fail), has no clean per-request timeouts and treats credentials
 * inconsistently. Instead ffmpeg reads http://127.0.0.1/internal/ftp/... and
 * this bridge turns each HTTP Range request into an FTP REST + RETR on the
 * HyperDeck. Seeking inside a huge ProRes file only transfers what is needed.
 *
 * The same endpoint (with a user download flag) lets the panel download the
 * original file.
 */
export class FtpBridge {
  readonly token = crypto.randomBytes(16).toString('hex');
  private port = 0;
  private sizes = new Map<string, { size: number; at: number }>();

  setPort(port: number) {
    this.port = port;
  }

  url(deviceId: string, remotePath: string): string {
    return `http://127.0.0.1:${this.port}/internal/ftp/${deviceId}?t=${this.token}&p=${encodeURIComponent(remotePath)}`;
  }

  register(app: FastifyInstance, getDevice: (id: string) => Device | undefined) {
    app.get<{ Params: { id: string }; Querystring: { p: string; t?: string; download?: string } }>('/internal/ftp/:id', async (req, reply) => {
      const device = getDevice(req.params.id);
      const remotePath = req.query.p;
      // Internal use is token-protected; user downloads go through /api which re-issues with the token.
      if (req.query.t !== this.token) return reply.status(403).send({ error: 'forbidden' });
      if (!device || !remotePath || remotePath.includes('..')) return reply.status(404).send({ error: 'not found' });

      reply.hijack();
      const res = reply.raw;
      const ftp = new FtpClient(20000);
      let closed = false;
      const cleanup = () => {
        if (closed) return;
        closed = true;
        ftp.close();
      };
      req.raw.on('close', cleanup);

      try {
        await ftp.access({
          host: device.host, port: device.ftp.port,
          user: device.ftp.user || 'anonymous', password: device.ftp.password || '', secure: false,
        });
        const size = await this.size(ftp, device.id, remotePath);
        const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
        let start = 0;
        let end = size - 1;
        if (m) {
          if (m[1]) start = Number(m[1]);
          else if (m[2]) start = Math.max(0, size - Number(m[2]));
          if (m[1] && m[2]) end = Math.min(size - 1, Number(m[2]));
        }
        if (start >= size) {
          res.writeHead(416, { 'Content-Range': `bytes */${size}` });
          res.end();
          cleanup();
          return;
        }
        const length = end - start + 1;
        const headers: Record<string, string | number> = {
          'Accept-Ranges': 'bytes',
          'Content-Length': length,
          'Content-Type': 'application/octet-stream',
        };
        if (req.query.download) {
          const name = remotePath.split('/').pop() ?? 'clip';
          headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
        }
        if (m) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
        res.writeHead(m ? 206 : 200, headers);

        let remaining = length;
        const sink = new Writable({
          write(chunk: Buffer, _enc, cb) {
            if (closed) return cb();
            const part = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
            remaining -= part.length;
            const ok = res.write(part);
            if (remaining <= 0) {
              res.end();
              cleanup(); // stop the RETR; we have what was asked for
              return cb();
            }
            if (ok) cb();
            else res.once('drain', () => cb());
          },
        });
        await ftp.downloadTo(sink, remotePath, start).catch((e) => {
          if (!closed) throw e;
        });
        if (!res.writableEnded) res.end();
      } catch (e) {
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: (e as Error).message }));
        } else res.destroy();
      } finally {
        cleanup();
      }
    });
  }

  private async size(ftp: FtpClient, deviceId: string, remotePath: string): Promise<number> {
    const key = `${deviceId}:${remotePath}`;
    const hit = this.sizes.get(key);
    // Files being recorded grow; keep the cache short.
    if (hit && Date.now() - hit.at < 5000) return hit.size;
    const size = await ftp.size(remotePath);
    this.sizes.set(key, { size, at: Date.now() });
    return size;
  }
}

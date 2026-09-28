/**
 * Mock HyperDeck for development and tests — fixed ports, longer clips.
 *
 *  - Ethernet protocol server on :9993 (MOCK_PORT).
 *  - Anonymous FTP on :2121 (MOCK_FTP_PORT) exposing ssd1/ and ssd2/.
 *  - REST API on :8081 (MOCK_REST_PORT).
 *  - Slot 3 simulates network storage: its files live in .mock-media/nas which
 *    is NOT on FTP — map it as a share on the device to read it.
 *
 * Usage: npx tsx tools/mock-hyperdeck.ts   (generates test clips with ffmpeg on first run)
 *
 * The same simulated deck (server/src/testdeck/mockDeck.ts) also powers the
 * in-app "Add test HyperDeck" button, with ephemeral ports and shorter clips.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockDeck } from '../server/src/testdeck/mockDeck.js';

const here = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const deck = await createMockDeck({
    host: process.env.MOCK_HOST ?? '0.0.0.0',
    port: Number(process.env.MOCK_PORT ?? 9993),
    ftpPort: Number(process.env.MOCK_FTP_PORT ?? 2121),
    restPort: Number(process.env.MOCK_REST_PORT ?? 8081),
    mediaDir: path.join(here, '.mock-media'),
    ffmpeg: process.env.FFMPEG_PATH ?? 'ffmpeg',
    ffprobe: process.env.FFPROBE_PATH ?? 'ffprobe',
    clipSeconds: { camA: 20, interview: 15, nas: 18 },
    verbose: Boolean(process.env.MOCK_VERBOSE),
  });
  console.log(`[mock] HyperDeck protocol on ${deck.host}:${deck.port}`);
  console.log(`[mock] FTP on ${deck.host}:${deck.ftpPort}`);
  console.log(`[mock] REST API on ${deck.host}:${deck.restPort}/control/api/v1`);
  console.log(`[mock] NAS share folder (map this as the device share): ${deck.nasDir}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

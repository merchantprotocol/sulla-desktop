/**
 * Service — local Unix domain socket for mic PCM audio streaming.
 *
 * The main process writes mic PCM data to this socket. The renderer
 * (Capture Studio) connects and reads the data to write WAV to disk.
 *
 * Supports two PCM modes controlled by the capture studio's quality setting:
 *   - 'raw'              — all audio, no processing (ASMR, music, environment)
 *   - 'noise-reduction'  — VAD-gated + noise-processed (voice recording)
 *
 * Both deliver 48kHz mono s16le PCM. The mode determines which
 * MicrophoneDriverController callback feeds this socket.
 *
 * Protocol (per message):
 *   4 bytes (UInt32BE) — payload length
 *   N bytes            — raw PCM data (48kHz, mono, s16le)
 *
 * Same pattern as speaker-socket.ts — main process → socket → renderer.
 */

import net from 'net';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { log } from '../model/logger';

const TAG = 'MicPcmSocket';

let server: net.Server | null = null;
let socketPath: string | null = null;
const clients: Set<net.Socket> = new Set();
let chunkCount = 0;

/**
 * Start the Unix domain socket server.
 * Clients that connect will receive length-prefixed PCM frames.
 */
export function start(): string | null {
  if (server) return socketPath;

  chunkCount = 0;
  socketPath = path.join(os.tmpdir(), `audio-driver-mic-pcm-${ process.pid }.sock`);

  try { fs.unlinkSync(socketPath); } catch {}

  server = net.createServer((conn: net.Socket) => {
    log.info(TAG, 'Client connected');
    clients.add(conn);

    conn.on('close', () => {
      log.info(TAG, 'Client disconnected');
      clients.delete(conn);
    });

    conn.on('error', (err: Error) => {
      log.warn(TAG, 'Client error', { error: err.message });
      clients.delete(conn);
    });
  });

  server.on('error', (err: Error) => {
    log.error(TAG, 'Server error', { error: err.message });
  });

  server.listen(socketPath, () => {
    log.info(TAG, 'Listening', { path: socketPath });
  });

  return socketPath;
}

/**
 * Write a PCM chunk to all connected clients.
 * Called from init.ts via MicrophoneDriverController PCM callbacks.
 */
export function writeChunk(pcmData: Buffer): void {
  if (clients.size === 0) return;

  const header = Buffer.alloc(4);
  header.writeUInt32BE(pcmData.length, 0);
  const frame = Buffer.concat([header, pcmData]);

  chunkCount++;
  if (chunkCount <= 3 || chunkCount % 500 === 0) {
    log.debug(TAG, 'Mic PCM chunk broadcast', { bytes: pcmData.length, clients: clients.size, total: chunkCount });
  }

  for (const client of clients) {
    if (!client.destroyed) {
      client.write(frame);
    }
  }
}

/** Whether any clients are connected (recording in progress). */
export function hasClients(): boolean {
  return clients.size > 0;
}

/**
 * Stop the socket server and disconnect all clients.
 */
export function stop(): void {
  for (const client of clients) {
    client.destroy();
  }
  clients.clear();

  if (server) {
    server.close();
    server = null;
  }

  if (socketPath) {
    try { fs.unlinkSync(socketPath); } catch {}
    log.info(TAG, 'Stopped', { path: socketPath });
    socketPath = null;
  }

  chunkCount = 0;
}

/**
 * Get the socket path (for passing to renderer via IPC).
 */
export function getPath(): string | null {
  return socketPath;
}

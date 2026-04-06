/**
 * Service — local Unix domain socket for mic audio streaming.
 *
 * Replaces the IPC-based mic audio path. The renderer connects to
 * this socket and writes length-prefixed binary chunks directly,
 * avoiding Electron IPC serialization overhead entirely.
 *
 * Protocol (per message):
 *   4 bytes (UInt32BE) — payload length
 *   N bytes            — WebM/Opus audio data
 *
 * Follows the same pattern as speaker capture, which streams PCM
 * via a subprocess pipe rather than IPC.
 */

import net from 'net';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { log } from '../model/logger';

const TAG = 'MicSocket';

let server: net.Server | null = null;
let socketPath: string | null = null;
let activeConnection: net.Socket | null = null;
let onAudioChunk: ((chunk: Buffer) => void) | null = null;
let micChunkCount = 0;

/**
 * Start the Unix domain socket server.
 *
 * @param onChunk — called with Buffer for each mic audio chunk
 * @returns socketPath — path the renderer should connect to
 */
export function start(onChunk: (chunk: Buffer) => void): string | null {
  if (server) return socketPath;

  onAudioChunk = onChunk;
  micChunkCount = 0;

  // Use a temp path for the socket
  socketPath = path.join(os.tmpdir(), `audio-driver-mic-${process.pid}.sock`);

  // Clean up stale socket file if it exists
  try { fs.unlinkSync(socketPath); } catch {}

  server = net.createServer((conn: net.Socket) => {
    log.info(TAG, 'Renderer connected');

    // Only allow one connection at a time
    if (activeConnection) {
      log.warn(TAG, 'Replacing existing connection');
      activeConnection.destroy();
    }
    activeConnection = conn;

    // Accumulate incoming data and parse length-prefixed frames
    let pending: any = Buffer.alloc(0);

    conn.on('data', (data: any) => {
      pending = pending.length > 0 ? Buffer.concat([pending, data]) : data;

      // Parse all complete frames in the buffer
      while (pending.length >= 4) {
        const frameLen = pending.readUInt32BE(0);
        if (frameLen === 0 || frameLen > 1024 * 1024) {
          // Invalid frame — reset
          log.warn(TAG, 'Invalid frame length, resetting buffer', { frameLen });
          pending = Buffer.alloc(0);
          break;
        }

        if (pending.length < 4 + frameLen) break; // wait for more data

        const chunk = pending.subarray(4, 4 + frameLen);
        pending = pending.subarray(4 + frameLen);

        micChunkCount++;
        if (micChunkCount <= 3 || micChunkCount % 100 === 0) {
          log.debug(TAG, 'Mic audio chunk', { bytes: chunk.length, total: micChunkCount });
        }

        if (onAudioChunk) onAudioChunk(chunk);
      }
    });

    conn.on('close', () => {
      log.info(TAG, 'Renderer disconnected');
      if (activeConnection === conn) activeConnection = null;
    });

    conn.on('error', (err: Error) => {
      log.warn(TAG, 'Connection error', { error: err.message });
      if (activeConnection === conn) activeConnection = null;
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
 * Stop the socket server and clean up.
 */
export function stop(): void {
  if (activeConnection) {
    activeConnection.destroy();
    activeConnection = null;
  }

  if (server) {
    server.close();
    server = null;
  }

  if (socketPath) {
    try { fs.unlinkSync(socketPath); } catch {}
    log.info(TAG, 'Stopped', { path: socketPath });
    socketPath = null;
  }

  onAudioChunk = null;
  micChunkCount = 0;
}

/**
 * Get the socket path (for passing to renderer via IPC handle).
 */
export function getPath(): string | null {
  return socketPath;
}

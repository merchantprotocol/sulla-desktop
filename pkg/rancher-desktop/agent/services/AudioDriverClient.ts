/**
 * AudioDriverClient — connects to the audio-driver's local Unix socket
 * and receives labeled audio chunks (mic + speaker).
 *
 * The audio-driver captures system/speaker audio via WASAPI (Windows)
 * or CoreAudio+BlackHole (macOS) and streams it over a local socket.
 *
 * Protocol (binary frames):
 *   [1 byte: source (0=mic, 1=speaker)]
 *   [4 bytes: payload length, big-endian]
 *   [N bytes: raw PCM audio]
 *
 * This client runs in the main process. Incoming speaker chunks are
 * forwarded to the gateway via the existing audio pipeline.
 *
 * If the audio-driver daemon is not running, the client will attempt
 * to start it via launchctl (macOS) or run the binary directly.
 * If the daemon is not installed, it stops retrying and emits
 * 'not-installed' so the UI can inform the user.
 */

import * as net from 'net';
import * as fs from 'fs';
import { EventEmitter } from 'events';
import { execFile } from 'child_process';

export interface AudioChunk {
  source: 'mic' | 'speaker';
  channel: number;
  audio: Buffer;
}

const DEFAULT_SOCKET_PATH = process.platform === 'win32'
  ? '\\\\.\\pipe\\audio-driver'
  : '/tmp/audio-driver.sock';

const PLIST_LABEL = 'com.audiodriver.agent';
const PLIST_PATH = '/Library/LaunchDaemons/com.audiodriver.agent.plist';
const BINARY_PATH = '/usr/local/bin/audio-driver';
const INSTALL_REPO = 'https://raw.githubusercontent.com/merchantprotocol/sulla-audio/main/install.sh';

const HEADER_SIZE = 5; // 1 byte source + 4 bytes length

// Reconnect intervals
const RECONNECT_FAST = 2_000;    // 2s — daemon is running, transient disconnect
const RECONNECT_SLOW = 30_000;   // 30s — daemon not available, poll for it

export class AudioDriverClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private _connected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = false;
  private socketPath: string;
  private daemonAvailable = false;     // true once we've successfully connected at least once
  private consecutiveFailures = 0;

  constructor(socketPath?: string) {
    super();
    this.socketPath = socketPath || DEFAULT_SOCKET_PATH;
  }

  get connected(): boolean {
    return this._connected;
  }

  /**
   * Connect to the audio-driver socket. If the daemon isn't running,
   * attempts to start it first. Idempotent — safe to call repeatedly.
   */
  async connect(): Promise<void> {
    if (this._connected || this.socket) {
      return;
    }

    this.shouldReconnect = true;

    // Try to ensure the daemon is running before connecting
    const ready = await this.ensureRunning();

    if (ready) {
      this.doConnect();
    } else {
      // Daemon not available — schedule a slow poll instead of hammering
      this.scheduleReconnect(RECONNECT_SLOW);
    }
  }

  private doConnect(): void {
    console.log(`[AudioDriverClient] Connecting to ${ this.socketPath }...`);

    this.socket = net.createConnection(this.socketPath);

    this.socket.on('connect', () => {
      this._connected = true;
      this.daemonAvailable = true;
      this.consecutiveFailures = 0;
      this.buffer = Buffer.alloc(0);
      console.log('[AudioDriverClient] Connected to audio-driver');
      this.emit('connected');
    });

    this.socket.on('data', (data: Buffer) => {
      this.onData(data);
    });

    this.socket.on('close', () => {
      this._connected = false;
      this.socket = null;

      if (this.shouldReconnect) {
        this.consecutiveFailures++;

        if (this.daemonAvailable && this.consecutiveFailures <= 3) {
          // Was previously connected — likely a transient disconnect
          console.log('[AudioDriverClient] Disconnected, reconnecting shortly...');
          this.scheduleReconnect(RECONNECT_FAST);
        } else {
          // Multiple failures or never connected — daemon probably died
          console.log('[AudioDriverClient] Disconnected, will try to restart daemon...');
          this.scheduleReconnectWithEnsure();
        }
      } else {
        console.log('[AudioDriverClient] Disconnected');
      }

      this.emit('disconnected');
    });

    this.socket.on('error', (err: Error) => {
      const code = (err as NodeJS.ErrnoException).code;

      if (code !== 'ENOENT' && code !== 'ECONNREFUSED') {
        console.error('[AudioDriverClient] Socket error:', err.message);
      }
      // Don't emit 'error' on expected connection failures — they're
      // handled by the 'close' event and reconnect logic above.
    });
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this._connected = false;
    this.buffer = Buffer.alloc(0);
  }

  private scheduleReconnect(delay: number): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shouldReconnect && !this._connected) {
        this.doConnect();
      }
    }, delay);
  }

  /**
   * Schedule a reconnect that first tries to ensure the daemon is running.
   */
  private scheduleReconnectWithEnsure(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(async() => {
      this.reconnectTimer = null;
      if (!this.shouldReconnect || this._connected) return;

      const ready = await this.ensureRunning();

      if (ready) {
        this.doConnect();
      } else {
        // Still not available — back off further
        this.scheduleReconnect(RECONNECT_SLOW);
      }
    }, RECONNECT_FAST);
  }

  // ─── Ensure the audio-driver daemon is running ───────────────

  /**
   * Check if the daemon is running and the socket is available.
   * If not, attempt to start it. Returns true if the socket is
   * available and ready for connection.
   *
   * Idempotent — calling when the daemon is already running is a no-op.
   */
  private async ensureRunning(): Promise<boolean> {
    // 1. Socket already exists — daemon is running
    if (this.socketExists()) {
      return true;
    }

    // 2. Binary installed + plist exists — try to start the service
    if (this.binaryInstalled() && this.plistExists()) {
      console.log('[AudioDriverClient] Daemon not running. Starting via launchctl...');
      if (await this.startService()) {
        return true;
      }
    }

    // 3. Binary installed but no plist — run it directly
    if (this.binaryInstalled()) {
      console.log('[AudioDriverClient] No launchd plist. Starting audio-driver directly...');
      if (await this.startDirect()) {
        return true;
      }
    }

    // 4. Nothing installed
    if (!this.binaryInstalled()) {
      console.warn(
        `[AudioDriverClient] audio-driver is not installed. Install it:\n` +
        `  curl -fsSL ${ INSTALL_REPO } | sudo bash`,
      );
      this.emit('not-installed');
    }

    return false;
  }

  private socketExists(): boolean {
    try {
      return fs.statSync(this.socketPath).isSocket();
    } catch {
      return false;
    }
  }

  private binaryInstalled(): boolean {
    try {
      fs.accessSync(BINARY_PATH, fs.constants.X_OK);

      return true;
    } catch {
      return false;
    }
  }

  private plistExists(): boolean {
    try {
      fs.accessSync(PLIST_PATH, fs.constants.R_OK);

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Start the launchd service. Tries bootstrap first (if not loaded),
   * then kickstart (if loaded but stopped).
   */
  private startService(): Promise<boolean> {
    return new Promise((resolve) => {
      execFile('launchctl', ['bootstrap', 'system', PLIST_PATH], (err) => {
        if (!err) {
          console.log('[AudioDriverClient] launchctl bootstrap succeeded');

          return this.waitForSocket().then(resolve);
        }

        // Already loaded — try kickstart to restart it
        execFile('launchctl', ['kickstart', '-k', `system/${ PLIST_LABEL }`], (kickErr) => {
          if (!kickErr) {
            console.log('[AudioDriverClient] launchctl kickstart succeeded');

            return this.waitForSocket().then(resolve);
          }

          console.warn('[AudioDriverClient] launchctl start failed:', kickErr?.message);
          resolve(false);
        });
      });
    });
  }

  /**
   * Start the binary directly as a background process (fallback when
   * launchd plist is missing).
   */
  private startDirect(): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const child = execFile(BINARY_PATH, ['--mode', 'local'], {
          stdio: 'ignore' as any,
          detached: true,
        } as any);

        child.unref?.();
        console.log('[AudioDriverClient] Started audio-driver directly (pid:', child.pid, ')');
        this.waitForSocket().then(resolve);
      } catch (err: any) {
        console.warn('[AudioDriverClient] Direct start failed:', err.message);
        resolve(false);
      }
    });
  }

  /**
   * Wait up to 5 seconds for the socket to appear.
   */
  private waitForSocket(): Promise<boolean> {
    return new Promise((resolve) => {
      let tries = 0;
      const check = () => {
        if (this.socketExists()) {
          console.log('[AudioDriverClient] Socket is live');
          resolve(true);

          return;
        }
        tries++;
        if (tries >= 10) {
          console.warn('[AudioDriverClient] Socket did not appear after 5s');
          resolve(false);

          return;
        }
        setTimeout(check, 500);
      };

      check();
    });
  }

  // ─── Binary frame parser ─────────────────────────────────────

  /**
   * Parse incoming binary data into AudioChunks.
   * Protocol: [1B source][4B length BE][NB audio]
   */
  private onData(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);

    while (this.buffer.length >= HEADER_SIZE) {
      const source = this.buffer[0];
      const payloadLength = this.buffer.readUInt32BE(1);

      if (this.buffer.length < HEADER_SIZE + payloadLength) {
        break; // Wait for more data
      }

      const audio = this.buffer.subarray(HEADER_SIZE, HEADER_SIZE + payloadLength);
      this.buffer = this.buffer.subarray(HEADER_SIZE + payloadLength);

      const chunk: AudioChunk = {
        source:  source === 0 ? 'mic' : 'speaker',
        channel: source,
        audio:   Buffer.from(audio), // Copy so subarray doesn't hold the whole buffer
      };

      this.emit('chunk', chunk);
    }
  }
}

// ─── Singleton ─────────────────────────────────────────────────

let instance: AudioDriverClient | null = null;

export function getAudioDriverClient(): AudioDriverClient {
  if (!instance) {
    instance = new AudioDriverClient();
  }
  return instance;
}

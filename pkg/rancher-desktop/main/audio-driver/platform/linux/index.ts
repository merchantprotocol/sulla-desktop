/**
 * Linux audio backend — PulseAudio / PipeWire.
 *
 * Linux has built-in monitor sources for capturing system audio.
 * No virtual driver or aggregate device needed.
 *
 * Tools used:
 *   - pactl      — device listing, switching, module loading
 *   - parec      — raw audio capture from monitor source
 *   - pactl subscribe — monitor device changes
 */

import { execSync, spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { log } from '../../model/logger';

// ─── Meter smoothing (matches macOS Swift capture) ─────────
const ATTACK = 0.3;
const DECAY = 0.05;
let smoothedLevel = 0;

function smoothRms(raw: number): number {
  if (raw > smoothedLevel) {
    smoothedLevel += (raw - smoothedLevel) * ATTACK;
  } else {
    smoothedLevel += (raw - smoothedLevel) * DECAY;
  }
  return smoothedLevel;
}

// ─── Loopback Driver ────────────────────────────────────────
// Linux PulseAudio/PipeWire has built-in monitor sources.
// No external driver needed.

export const loopback = {
  async detect(): Promise<any> {
    try {
      execSync('pactl info', { timeout: 5000, stdio: 'pipe' });
      log.info('Platform', 'PulseAudio/PipeWire available');
      return { found: true, name: 'PulseAudio Monitor', driver: 'pulseaudio' };
    } catch {
      log.warn('Platform', 'PulseAudio not available');
      return { found: false };
    }
  },

  async install(): Promise<boolean> {
    // Nothing to install — monitor sources are built-in
    log.info('Platform', 'No loopback driver needed on Linux');
    return true;
  },

  remove(): void {
    // Nothing to remove
  },
};

// ─── Mirror / Audio Routing ─────────────────────────────────
// On Linux, we use module-combine-sink to mirror audio to a
// monitor source for capture. Or we can capture directly from
// the default sink's monitor without any routing changes.

let combineSinkModule: number | null = null;

export const mirror = {
  async status(): Promise<{ exists: boolean }> {
    return { exists: combineSinkModule !== null };
  },

  async enable(name?: string): Promise<boolean> {
    // Capture directly from the default sink's monitor —
    // no routing changes needed on Linux.
    log.info('Platform', 'Mirror enabled (using default sink monitor)', { name });
    return true;
  },

  async disable(): Promise<boolean> {
    if (combineSinkModule !== null) {
      try {
        execSync(`pactl unload-module ${ combineSinkModule }`, { timeout: 5000, stdio: 'pipe' });
        log.info('Platform', 'Combine sink removed');
      } catch {
        // Best effort
      }
      combineSinkModule = null;
    }
    return true;
  },
};

// ─── Output Watcher ─────────────────────────────────────────
// Uses `pactl subscribe` to monitor for sink changes.

let watcherProcess: ChildProcess | null = null;

export const watcher = {
  start(onOutputChanged: (event: any) => void): void {
    if (watcherProcess) {
      log.warn('Platform', 'Watcher already running');
      return;
    }

    log.info('Platform', 'Starting output device watcher (pactl subscribe)');
    watcherProcess = spawn('pactl', ['subscribe'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    watcherProcess.stdout!.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        // pactl subscribe outputs lines like:
        // Event 'change' on server #0
        // Event 'change' on sink #1
        if (line.includes('sink') && line.includes('change')) {
          try {
            const defaultSink = execSync('pactl get-default-sink', {
              timeout: 3000,
              stdio:   'pipe',
            }).toString().trim();

            // Get sink info
            const info = execSync('pactl list sinks short', {
              timeout: 3000,
              stdio:   'pipe',
            }).toString().trim();

            const sinkLine = info.split('\n').find((l) => l.includes(defaultSink));
            if (sinkLine) {
              onOutputChanged({
                event: 'output-changed',
                name:  defaultSink,
                uid:   defaultSink,
              });
            }
          } catch {
            // Best effort
          }
        }
      }
    });

    watcherProcess.on('close', (code: number | null) => {
      log.info('Platform', 'Watcher exited', { code });
      watcherProcess = null;
    });

    watcherProcess.on('error', (err: Error) => {
      log.error('Platform', 'Watcher spawn error', { error: err.message });
      watcherProcess = null;
    });
  },

  stop(): void {
    if (watcherProcess) {
      log.info('Platform', 'Stopping watcher');
      watcherProcess.kill('SIGTERM');
      watcherProcess = null;
    }
  },
};

// ─── Audio Capture ──────────────────────────────────────────
// Uses `parec` to capture from the default sink's monitor source.
// Computes RMS in JS from raw PCM data.

let captureChild: ChildProcess | null = null;
let captureCallback: ((level: number) => void) | null = null;

export const capture = {
  start(onLevel: (level: number) => void): void {
    if (captureChild) {
      log.warn('Platform', 'Capture already running');
      return;
    }

    captureCallback = onLevel;
    smoothedLevel = 0;

    // Get the default sink's monitor source
    let monitorSource: string;
    try {
      const defaultSink = execSync('pactl get-default-sink', {
        timeout: 3000,
        stdio:   'pipe',
      }).toString().trim();
      monitorSource = defaultSink + '.monitor';
    } catch {
      monitorSource = '@DEFAULT_MONITOR@';
    }

    log.info('Platform', 'Starting capture', { source: monitorSource });

    // Capture 16-bit signed LE mono at 16kHz
    captureChild = spawn('parec', [
      '--device', monitorSource,
      '--format=s16le',
      '--channels=1',
      '--rate=16000',
      '--raw',
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Process raw PCM data and compute RMS
    captureChild.stdout!.on('data', (data: Buffer) => {
      if (!captureCallback) return;

      const samples = data.length / 2;
      if (samples === 0) return;

      let sum = 0;
      for (let i = 0; i < data.length; i += 2) {
        const sample = data.readInt16LE(i) / 32768;
        sum += sample * sample;
      }
      const rms = Math.min(1, Math.sqrt(sum / samples) * 3);
      captureCallback(smoothRms(rms));
    });

    captureChild.on('close', (code: number | null) => {
      log.info('Platform', 'Capture exited', { code });
      captureChild = null;
    });

    captureChild.on('error', (err: Error) => {
      log.error('Platform', 'Capture spawn error', { error: err.message });
      captureChild = null;
    });
  },

  stop(): void {
    if (captureChild) {
      log.info('Platform', 'Stopping capture');
      captureChild.kill('SIGTERM');
      captureChild = null;
    }
    captureCallback = null;
  },

  isRunning(): boolean {
    return captureChild !== null && !captureChild.killed;
  },
};

// ─── Device Switching ───────────────────────────────────────

export const devices = {
  async setOutput(deviceName: string): Promise<any> {
    log.info('Platform', 'Setting system output', { deviceName });
    try {
      // List sinks and find matching one
      const sinks = execSync('pactl list sinks short', { timeout: 5000, stdio: 'pipe' })
        .toString().trim().split('\n');

      const match = sinks.find((l) => l.toLowerCase().includes(deviceName.toLowerCase()));
      if (!match) {
        return { ok: false, error: `No sink matching '${ deviceName }'` };
      }

      const sinkName = match.split('\t')[1];
      execSync(`pactl set-default-sink "${ sinkName }"`, { timeout: 5000, stdio: 'pipe' });
      log.info('Platform', 'System output changed', { sink: sinkName });
      return { ok: true, name: sinkName, uid: sinkName };
    } catch (e: any) {
      log.error('Platform', 'Failed to set output', { error: e.message });
      return { ok: false, error: e.message };
    }
  },

  async setInput(deviceName: string): Promise<any> {
    log.info('Platform', 'Setting system input', { deviceName });
    try {
      const sources = execSync('pactl list sources short', { timeout: 5000, stdio: 'pipe' })
        .toString().trim().split('\n');

      const match = sources.find((l) =>
        l.toLowerCase().includes(deviceName.toLowerCase()) && !l.includes('.monitor'),
      );
      if (!match) {
        return { ok: false, error: `No source matching '${ deviceName }'` };
      }

      const sourceName = match.split('\t')[1];
      execSync(`pactl set-default-source "${ sourceName }"`, { timeout: 5000, stdio: 'pipe' });
      log.info('Platform', 'System input changed', { source: sourceName });
      return { ok: true, name: sourceName, uid: sourceName };
    } catch (e: any) {
      log.error('Platform', 'Failed to set input', { error: e.message });
      return { ok: false, error: e.message };
    }
  },

  async resetOutput(): Promise<void> {
    // No-op on Linux — no aggregate device to get stuck on
  },
};

// ─── Volume Control ────────────────────────────────────────
// Uses pactl for volume control. Linux volume keys work natively.

export const volume = {
  async getDefaultOutputUID(): Promise<string | null> {
    try {
      return execSync('pactl get-default-sink', { timeout: 3000, stdio: 'pipe' }).toString().trim();
    } catch {
      return null;
    }
  },

  async get(deviceUID?: string): Promise<any> {
    try {
      const info = execSync(`pactl get-sink-volume "${ deviceUID || '@DEFAULT_SINK@' }"`, {
        timeout: 3000, stdio: 'pipe',
      }).toString();
      const match = info.match(/(\d+)%/);
      const pct = match ? parseInt(match[1], 10) : 0;

      const muteInfo = execSync(`pactl get-sink-mute "${ deviceUID || '@DEFAULT_SINK@' }"`, {
        timeout: 3000, stdio: 'pipe',
      }).toString();
      const muted = muteInfo.includes('yes');

      return { ok: true, volume: pct / 100, muted };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  },

  async set(deviceUID: string, level: number): Promise<any> {
    try {
      const pct = Math.round(Math.max(0, Math.min(1, level)) * 100);
      execSync(`pactl set-sink-volume "${ deviceUID || '@DEFAULT_SINK@' }" ${ pct }%`, {
        timeout: 3000, stdio: 'pipe',
      });
      return volume.get(deviceUID);
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  },

  async inc(deviceUID: string, step?: number): Promise<any> {
    try {
      const pct = Math.round((step || 0.0625) * 100);
      execSync(`pactl set-sink-volume "${ deviceUID || '@DEFAULT_SINK@' }" +${ pct }%`, {
        timeout: 3000, stdio: 'pipe',
      });
      execSync(`pactl set-sink-mute "${ deviceUID || '@DEFAULT_SINK@' }" 0`, {
        timeout: 3000, stdio: 'pipe',
      });
      return volume.get(deviceUID);
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  },

  async dec(deviceUID: string, step?: number): Promise<any> {
    try {
      const pct = Math.round((step || 0.0625) * 100);
      execSync(`pactl set-sink-volume "${ deviceUID || '@DEFAULT_SINK@' }" -${ pct }%`, {
        timeout: 3000, stdio: 'pipe',
      });
      return volume.get(deviceUID);
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  },

  async toggleMute(deviceUID?: string): Promise<any> {
    try {
      execSync(`pactl set-sink-mute "${ deviceUID || '@DEFAULT_SINK@' }" toggle`, {
        timeout: 3000, stdio: 'pipe',
      });
      return volume.get(deviceUID);
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  },

  async adjust(deviceUID: string, cmd: string, value?: number): Promise<any> {
    switch (cmd) {
    case 'get': return volume.get(deviceUID);
    case 'set': return volume.set(deviceUID, value!);
    case 'inc': return volume.inc(deviceUID, value);
    case 'dec': return volume.dec(deviceUID, value);
    case 'toggle-mute': return volume.toggleMute(deviceUID);
    default: return { ok: false, error: `Unknown command: ${ cmd }` };
    }
  },
};

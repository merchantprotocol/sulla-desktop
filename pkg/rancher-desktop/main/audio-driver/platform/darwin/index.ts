/**
 * macOS audio backend — CoreAudio + BlackHole.
 *
 * Uses Swift helpers for CoreAudio operations:
 *   - detect-loopback.swift     — find BlackHole/custom loopback driver
 *   - create-multi-output.swift — create/destroy aggregate mirror device
 *   - capture-loopback.swift    — capture RMS levels from loopback input
 *   - watch-output.swift        — monitor default output device changes
 *   - set-system-device.swift   — change system input/output
 *   - reset-default-output.swift — reset output if stuck on loopback
 */

import { execFile, execSync, spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import path from 'path';
import { app } from 'electron';
import { log } from '../../model/logger';

// Resolve the path to native Swift scripts and the create-mirror binary.
// In dev: dist/app/audio-driver/platform/darwin/
// In production: app.asar.unpacked/audio-driver/platform/darwin/ (via asarUnpack)
const appDir = app.getAppPath().replace('app.asar', 'app.asar.unpacked');
const scriptDir = path.join(appDir, 'audio-driver', 'platform', 'darwin');

const SCRIPTS = {
  detect:        path.join(scriptDir, 'detect-loopback.swift'),
  mirror:        path.join(scriptDir, 'create-multi-output.swift'),
  capture:       path.join(scriptDir, 'capture-loopback.swift'),
  watch:         path.join(scriptDir, 'watch-output.swift'),
  setDevice:     path.join(scriptDir, 'set-system-device.swift'),
  resetOutput:   path.join(scriptDir, 'reset-default-output.swift'),
  volumeControl: path.join(scriptDir, 'volume-control.swift'),
};

// .app bundles launched from Finder get a minimal PATH. Ensure Homebrew is reachable.
const SHELL_PATH = [
  process.env.PATH,
  '/opt/homebrew/bin',
  '/usr/local/bin',
].filter(Boolean).join(':');
const CHILD_ENV = { ...process.env, PATH: SHELL_PATH };

// ─── Helpers ────────────────────────────────────────────────

function runSwift(scriptPath: string, args: string[] = []): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('swift', [scriptPath, ...args], { timeout: 15000, env: CHILD_ENV }, (err, stdout, stderr) => {
      const cleanStderr = (stderr || '')
        .split('\n')
        .filter((l) => !l.includes('warning:') && !l.match(/^\s*\d+\s*\|/) && !l.match(/^\s*`-/) && l.trim())
        .join('\n')
        .trim();

      if (err) {
        resolve({ ok: false, stdout: stdout.trim(), stderr: cleanStderr });
      } else {
        resolve({ ok: true, stdout: stdout.trim(), stderr: cleanStderr });
      }
    });
  });
}

// ─── Loopback Driver ────────────────────────────────────────

export const loopback = {
  async detect(): Promise<any> {
    return new Promise((resolve) => {
      execFile('swift', [SCRIPTS.detect], { timeout: 20000, env: CHILD_ENV }, (err, stdout) => {
        try {
          const result = JSON.parse(stdout.trim());
          if (result.found) {
            log.info('Platform', 'Loopback driver detected', {
              name:   result.name,
              uid:    result.uid,
              driver: result.driver,
            });
          } else {
            log.warn('Platform', 'No loopback driver found');
          }
          resolve(result);
        } catch (e: any) {
          log.error('Platform', 'Loopback detection failed', { error: e.message });
          resolve({ found: false });
        }
      });
    });
  },

  async install(): Promise<boolean> {
    log.info('Platform', 'Installing BlackHole 2ch via Homebrew...');
    try {
      execSync('brew install --cask blackhole-2ch', { timeout: 120000, stdio: 'pipe', env: CHILD_ENV });
      log.info('Platform', 'BlackHole 2ch installed');

      try {
        execSync('sudo killall coreaudiod 2>/dev/null', { timeout: 10000, stdio: 'pipe', env: CHILD_ENV });
      } catch {
        // May fail without sudo
      }

      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const recheck = await loopback.detect();
        if (recheck.found) {
          log.info('Platform', 'Loopback driver confirmed after install');
          return true;
        }
        log.info('Platform', `Waiting for driver to load... (attempt ${ i + 1 }/5)`);
      }

      log.error('Platform', 'BlackHole installed but not detected — run \'sudo killall coreaudiod\' or reboot');
      return false;
    } catch (e: any) {
      log.error('Platform', 'Failed to install BlackHole', { error: e.message });
      return false;
    }
  },

  remove(): void {
    try {
      execSync('brew uninstall --cask blackhole-2ch 2>/dev/null', { timeout: 30000, stdio: 'pipe', env: CHILD_ENV });
      log.info('Platform', 'BlackHole uninstalled via Homebrew');
    } catch {
      try {
        execSync('rm -rf /Library/Audio/Plug-Ins/HAL/BlackHole2ch.driver', { timeout: 10000, stdio: 'pipe', env: CHILD_ENV });
      } catch {
        // Already gone
      }
    }

    try {
      execSync(
        'rm -rf /Library/Audio/Plug-Ins/HAL/AudioDriverLoopback2ch.driver /Library/Audio/Plug-Ins/HAL/SullaLoopback2ch.driver /Library/Audio/Plug-Ins/HAL/SullaLoopback2ch.driver.disabled',
        { timeout: 10000, stdio: 'pipe', env: CHILD_ENV },
      );
    } catch {
      // Already gone
    }

    try {
      execSync('killall coreaudiod 2>/dev/null', { timeout: 10000, stdio: 'pipe', env: CHILD_ENV });
      log.info('Platform', 'coreaudiod restarted');
    } catch {
      // Best effort
    }
  },
};

// ─── Mirror / Audio Routing ─────────────────────────────────

export const mirror = {
  async status(): Promise<{ exists: boolean }> {
    const result = await runSwift(SCRIPTS.mirror, ['--check']);
    return { exists: result.ok };
  },

  async enable(name?: string, forDeviceUID?: string): Promise<boolean> {
    log.info('Platform', 'Enabling mirror...', { name, forDeviceUID });
    const args: string[] = [];
    if (name) args.push('--name', name);
    if (forDeviceUID) args.push('--for-device', forDeviceUID);

    const result = await runSwift(SCRIPTS.mirror, args);
    if (result.ok) {
      log.info('Platform', 'Mirror enabled', { output: result.stdout });
    } else {
      log.error('Platform', 'Failed to enable mirror', { stderr: result.stderr });
    }
    return result.ok;
  },

  async disable(): Promise<boolean> {
    log.info('Platform', 'Disabling mirror...');
    const result = await runSwift(SCRIPTS.mirror, ['--remove']);
    if (result.ok) {
      log.info('Platform', 'Mirror disabled', { output: result.stdout });
    } else {
      log.error('Platform', 'Failed to disable mirror', { stderr: result.stderr });
    }
    return result.ok;
  },
};

// ─── Output Watcher ─────────────────────────────────────────

let watcherProcess: ChildProcess | null = null;
let watchLineBuffer = '';

export const watcher = {
  start(onOutputChanged: (event: any) => void): void {
    if (watcherProcess) {
      log.warn('Platform', 'Watcher already running');
      return;
    }

    log.info('Platform', 'Starting output device watcher');
    watcherProcess = spawn('swift', [SCRIPTS.watch], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env:   CHILD_ENV,
    });

    watcherProcess.stdout!.on('data', (data: Buffer) => {
      watchLineBuffer += data.toString();
      const lines = watchLineBuffer.split('\n');
      watchLineBuffer = lines.pop()!;

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.event === 'output-changed' && onOutputChanged) {
            onOutputChanged(event);
          }
        } catch {
          // Skip non-JSON
        }
      }
    });

    watcherProcess.stderr!.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg && !msg.includes('warning:')) {
        log.info('Platform', 'Watcher', { msg });
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
    watchLineBuffer = '';
  },
};

// ─── Audio Capture ──────────────────────────────────────────

let captureChild: ChildProcess | null = null;
let captureCallback: ((data: any) => void) | null = null;
let captureAudioCallback: ((data: Buffer) => void) | null = null;
let captureLineBuffer = '';

export const capture = {
  start(onLevel: (data: any) => void, opts?: { onAudio?: (data: Buffer) => void }): void {
    if (captureChild) {
      log.warn('Platform', 'Capture already running');
      return;
    }

    captureCallback = onLevel;
    captureAudioCallback = opts?.onAudio || null;
    log.info('Platform', 'Starting capture helper');

    captureChild = spawn('swift', [SCRIPTS.capture], {
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'], // fd 3 = raw PCM pipe
      env:   CHILD_ENV,
    });

    captureChild.stdout!.on('data', (data: Buffer) => {
      captureLineBuffer += data.toString();
      const lines = captureLineBuffer.split('\n');
      captureLineBuffer = lines.pop()!;

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (captureCallback && typeof parsed.rms === 'number') {
            captureCallback(parsed);
          }
        } catch {
          // Skip non-JSON (Swift compiler warnings)
        }
      }
    });

    // Raw PCM audio on fd 3 (for gateway streaming)
    if (captureChild.stdio[3]) {
      let pcmChunks = 0;
      (captureChild.stdio[3] as NodeJS.ReadableStream).on('data', (data: Buffer) => {
        pcmChunks++;
        if (pcmChunks <= 3 || pcmChunks % 500 === 0) {
          log.debug('Platform', 'Speaker PCM chunk', { bytes: data.length, total: pcmChunks });
        }
        if (captureAudioCallback) captureAudioCallback(data);
      });
    } else {
      log.warn('Platform', 'fd 3 not available — no raw PCM output from capture helper');
    }

    captureChild.stderr!.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg && !msg.includes('warning:')) {
        log.info('Platform', 'Capture helper', { msg });
      }
    });

    captureChild.on('close', (code: number | null) => {
      log.info('Platform', 'Capture helper exited', { code });
      captureChild = null;
    });

    captureChild.on('error', (err: Error) => {
      log.error('Platform', 'Capture spawn error', { error: err.message });
      captureChild = null;
    });
  },

  stop(): void {
    if (captureChild) {
      log.info('Platform', 'Stopping capture helper');
      captureChild.kill('SIGTERM');
      captureChild = null;
    }
    captureCallback = null;
    captureLineBuffer = '';
  },

  isRunning(): boolean {
    return captureChild !== null && !captureChild.killed;
  },
};

// ─── Device Switching ───────────────────────────────────────

export const devices = {
  async setOutput(deviceName: string): Promise<any> {
    log.info('Platform', 'Setting system output', { deviceName });
    return new Promise((resolve) => {
      execFile('swift', [SCRIPTS.setDevice, '--output', deviceName], { timeout: 15000, env: CHILD_ENV }, (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || '').trim();
          log.error('Platform', 'Failed to set system output', { deviceName, error: msg });
          resolve({ ok: false, error: msg });
        } else {
          try {
            resolve(JSON.parse(stdout.trim()));
          } catch {
            resolve({ ok: true });
          }
        }
      });
    });
  },

  async setInput(deviceName: string): Promise<any> {
    log.info('Platform', 'Setting system input', { deviceName });
    return new Promise((resolve) => {
      execFile('swift', [SCRIPTS.setDevice, '--input', deviceName], { timeout: 15000, env: CHILD_ENV }, (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || '').trim();
          log.error('Platform', 'Failed to set system input', { deviceName, error: msg });
          resolve({ ok: false, error: msg });
        } else {
          try {
            resolve(JSON.parse(stdout.trim()));
          } catch {
            resolve({ ok: true });
          }
        }
      });
    });
  },

  async resetOutput(): Promise<void> {
    try {
      const out = execSync(`swift "${ SCRIPTS.resetOutput }" 2>/dev/null`, {
        timeout: 15000,
        stdio:   'pipe',
        env:     CHILD_ENV,
      });
      const msg = out.toString().trim();
      if (msg) log.info('Platform', msg);
    } catch {
      // Already on a physical device
    }
  },
};

// ─── Volume Control ────────────────────────────────────────────
// Controls volume on the physical sub-device within the mirror aggregate.
// Used with globalShortcut to restore volume key functionality.

export const volume = {
  async getDefaultOutputUID(): Promise<string | null> {
    const result = await runSwift(SCRIPTS.volumeControl, ['default-uid']);
    if (result.ok) {
      try {
        const parsed = JSON.parse(result.stdout);
        if (parsed.ok) return parsed.uid;
      } catch { /* ignore */ }
    }
    return null;
  },

  async adjust(deviceUID: string, cmd: string, value?: number | string): Promise<any> {
    const args = [cmd, deviceUID];
    if (value !== undefined) args.push(String(value));

    const result = await runSwift(SCRIPTS.volumeControl, args);
    if (result.ok) {
      try {
        return JSON.parse(result.stdout);
      } catch {
        return { ok: false, error: 'Parse error' };
      }
    }
    log.error('Platform', 'Volume control failed', { cmd, stderr: result.stderr });
    return { ok: false, error: result.stderr };
  },

  async get(deviceUID: string): Promise<any> {
    return volume.adjust(deviceUID, 'get');
  },

  async set(deviceUID: string, level: number): Promise<any> {
    return volume.adjust(deviceUID, 'set', level);
  },

  async inc(deviceUID: string, step?: number): Promise<any> {
    return volume.adjust(deviceUID, 'inc', step);
  },

  async dec(deviceUID: string, step?: number): Promise<any> {
    return volume.adjust(deviceUID, 'dec', step);
  },

  async toggleMute(deviceUID: string): Promise<any> {
    return volume.adjust(deviceUID, 'toggle-mute');
  },
};

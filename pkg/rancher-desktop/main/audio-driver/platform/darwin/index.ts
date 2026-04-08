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
import fs from 'fs';
import os from 'os';
import path from 'path';
import { log } from '../../model/logger';
import paths from '@pkg/utils/paths';

// Native Swift scripts and create-mirror binary live in resources/darwin/audio-driver/
// Same pattern as all other platform binaries (rdctl, sulla-daemon, etc.)
const scriptDir = path.join(paths.resources, 'darwin', 'audio-driver');
log.info('Platform', 'Script directory', { scriptDir });

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
        execSync(
          'osascript -e \'do shell script "killall coreaudiod 2>/dev/null" with administrator privileges\'',
          { timeout: 15000, stdio: 'pipe', env: CHILD_ENV },
        );
      } catch {
        // User cancelled or coreaudiod not running — it will recover on its own
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

    // /Library/Audio/Plug-Ins/HAL/ is root-owned — use osascript for privilege elevation
    try {
      execSync(
        'osascript -e \'do shell script "rm -rf /Library/Audio/Plug-Ins/HAL/AudioDriverLoopback2ch.driver /Library/Audio/Plug-Ins/HAL/SullaLoopback2ch.driver /Library/Audio/Plug-Ins/HAL/SullaLoopback2ch.driver.disabled" with administrator privileges\'',
        { timeout: 15000, stdio: 'pipe', env: CHILD_ENV },
      );
    } catch {
      // User cancelled or already gone
    }

    // Restart coreaudiod so macOS picks up the driver removal.
    // This requires root — use osascript to show a native password dialog
    // instead of blocking on a terminal Password: prompt the user never sees.
    try {
      execSync(
        'osascript -e \'do shell script "killall coreaudiod 2>/dev/null" with administrator privileges\'',
        { timeout: 15000, stdio: 'pipe', env: CHILD_ENV },
      );
      log.info('Platform', 'coreaudiod restarted (via admin prompt)');
    } catch {
      // User cancelled or failed — best effort, coreaudiod will recover on reboot
      log.warn('Platform', 'coreaudiod restart skipped (no admin privileges)');
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

// ─── Whisper.cpp (Local STT Engine) ───────────────────────────

// Bundled whisper-cli binary lives alongside other platform binaries
const WHISPER_BINARY = path.join(paths.resources, 'darwin', 'bin', 'whisper-cli');

const WHISPER_MODELS_DIR = path.join(
  process.env.HOME || '/tmp',
  '.sulla', 'cache', 'whisper', 'models',
);

export const whisper = {
  async detect(): Promise<any> {
    try {
      // Prefer the bundled binary; fall back to PATH (e.g. brew install)
      let binaryPath = WHISPER_BINARY;

      if (!fs.existsSync(binaryPath)) {
        log.info('Platform', 'Bundled whisper-cli not found, checking PATH...', { expected: binaryPath });
        try {
          binaryPath = execSync('which whisper-cli 2>/dev/null || which whisper-cpp 2>/dev/null || which whisper 2>/dev/null', {
            timeout: 5000,
            stdio:   'pipe',
            env:     CHILD_ENV,
          }).toString().trim().split('\n')[0];
        } catch {
          binaryPath = '';
        }
        if (!binaryPath) {
          log.error('Platform', 'whisper-cli not found (bundled or PATH)');
          return { available: false };
        }
        log.info('Platform', 'whisper-cli found on PATH', { binaryPath });
      }

      const models = whisper.listModels();

      log.info('Platform', 'whisper.cpp detected', { binaryPath, models });
      return { available: true, version: '1.8.4', binaryPath, modelsPath: WHISPER_MODELS_DIR, models };
    } catch {
      return { available: false };
    }
  },

  async install(_onProgress?: (line: string) => void): Promise<{ ok: boolean; error?: string }> {
    // whisper-cli is bundled — nothing to install
    log.info('Platform', 'whisper-cli is bundled, no installation needed');
    return { ok: true };
  },

  async remove(_onProgress?: (line: string) => void): Promise<void> {
    // Bundled binary cannot be removed; only clean up downloaded models
    log.info('Platform', 'Removing downloaded whisper models...');
    try {
      if (fs.existsSync(WHISPER_MODELS_DIR)) {
        fs.rmSync(WHISPER_MODELS_DIR, { recursive: true, force: true });
        log.info('Platform', 'Whisper models removed');
      }
    } catch (err: any) {
      log.error('Platform', 'Failed to remove whisper models', { error: err.message });
    }
  },

  listModels(): string[] {
    try {
      const fs = require('fs') as typeof import('fs');
      if (!fs.existsSync(WHISPER_MODELS_DIR)) return [];
      return fs.readdirSync(WHISPER_MODELS_DIR)
        .filter((f: string) => f.startsWith('ggml-') && f.endsWith('.bin'))
        .map((f: string) => f.replace(/^ggml-/, '').replace(/\.bin$/, ''));
    } catch {
      return [];
    }
  },

  async downloadModel(model: string, onProgress?: (pct: number, status: string) => void): Promise<boolean> {
    const fs = require('fs') as typeof import('fs');
    log.info('Platform', 'Downloading whisper model', { model });

    // Ensure models directory exists
    if (!fs.existsSync(WHISPER_MODELS_DIR)) {
      fs.mkdirSync(WHISPER_MODELS_DIR, { recursive: true });
    }

    const modelFile = path.join(WHISPER_MODELS_DIR, `ggml-${ model }.bin`);
    if (fs.existsSync(modelFile)) {
      log.info('Platform', 'Model already exists', { model, modelFile });
      if (onProgress) onProgress(100, 'Already downloaded');
      return true;
    }

    const baseUrl = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';
    const url = `${ baseUrl }/ggml-${ model }.bin`;
    const tmpFile = `${ modelFile }.tmp`;

    return new Promise((resolve) => {
      // Use curl with --write-out to get progress info
      const proc = spawn('curl', ['-L', '--progress-bar', '-o', tmpFile, url], {
        env:   CHILD_ENV,
        stdio: 'pipe',
      });

      // curl writes progress to stderr
      proc.stderr?.on('data', (data: Buffer) => {
        const line = data.toString();
        // Parse curl progress bar: "  % Total    % Received % Xferd  ..."
        // or the simple progress bar like "###  45.2%"
        const pctMatch = line.match(/([\d.]+)%/);
        if (pctMatch && onProgress) {
          const pct = parseFloat(pctMatch[1]);
          onProgress(Math.min(99, pct), `Downloading: ${ Math.round(pct) }%`);
        }
      });

      const timeout = setTimeout(() => {
        log.error('Platform', 'Model download timed out', { model });
        proc.kill();
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
        resolve(false);
      }, 600000); // 10 min timeout

      proc.on('close', (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          // Move tmp to final
          try {
            fs.renameSync(tmpFile, modelFile);
            log.info('Platform', 'Model downloaded', { model, modelFile });
            if (onProgress) onProgress(100, 'Download complete');
            resolve(true);
          } catch (e: any) {
            log.error('Platform', 'Failed to move model file', { error: e.message });
            resolve(false);
          }
        } else {
          log.error('Platform', 'curl failed', { model, exitCode: code });
          try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
          resolve(false);
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        log.error('Platform', 'Failed to spawn curl', { error: err.message });
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
        resolve(false);
      });
    });
  },
};

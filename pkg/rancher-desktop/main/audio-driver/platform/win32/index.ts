/**
 * Windows audio backend — WASAPI loopback capture.
 *
 * Windows WASAPI has built-in loopback capture mode that can record
 * any output device's audio without a virtual driver.
 *
 * Tools used:
 *   - PowerShell + CoreAudio COM APIs — device/volume control
 *   - PowerShell WASAPI loopback — audio capture with RMS metering
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

// ─── PowerShell helpers ────────────────────────────────────

function runPS(script: string, timeout = 10000): string {
  const cmd = script.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  return execSync(`powershell -NoProfile -Command "${ cmd }"`, {
    timeout,
    stdio: 'pipe',
  }).toString().trim();
}

// ─── Loopback Driver ────────────────────────────────────────
// Windows WASAPI has built-in loopback mode. No virtual driver needed.

export const loopback = {
  async detect(): Promise<any> {
    log.info('Platform', 'WASAPI loopback available (built-in)');
    return { found: true, name: 'WASAPI Loopback', driver: 'wasapi' };
  },

  async install(): Promise<boolean> {
    log.info('Platform', 'No loopback driver needed on Windows');
    return true;
  },

  remove(): void {},
};

// ─── Mirror / Audio Routing ─────────────────────────────────
// Windows doesn't need audio routing for loopback capture.
// WASAPI can capture directly from any render endpoint.

export const mirror = {
  async status(): Promise<{ exists: boolean }> {
    return { exists: true };
  },

  async enable(name?: string): Promise<boolean> {
    log.info('Platform', 'Mirror enabled (WASAPI direct capture)', { name });
    return true;
  },

  async disable(): Promise<boolean> {
    log.info('Platform', 'Mirror disabled (no-op on Windows)');
    return true;
  },
};

// ─── Output Watcher ─────────────────────────────────────────

let watcherInterval: ReturnType<typeof setInterval> | null = null;
let lastDefaultDevice: string | null = null;

export const watcher = {
  start(onOutputChanged: (event: any) => void): void {
    if (watcherInterval) {
      log.warn('Platform', 'Watcher already running');
      return;
    }

    log.info('Platform', 'Starting output device watcher (polling)');
    lastDefaultDevice = getDefaultOutputName();

    watcherInterval = setInterval(() => {
      const current = getDefaultOutputName();
      if (current && current !== lastDefaultDevice) {
        lastDefaultDevice = current;
        onOutputChanged({
          event: 'output-changed',
          name:  current,
          uid:   current,
        });
      }
    }, 2000);
  },

  stop(): void {
    if (watcherInterval) {
      log.info('Platform', 'Stopping watcher');
      clearInterval(watcherInterval);
      watcherInterval = null;
    }
  },
};

function getDefaultOutputName(): string | null {
  try {
    return runPS(`
      Add-Type -TypeDefinition @'
      using System.Runtime.InteropServices;
      [Guid("BCDE0395-E52F-467C-8E3D-C4579291692E"), ComImport, ClassInterface(ClassInterfaceType.None)]
      public class MMDeviceEnumerator {}
      [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
      public interface IMMDeviceEnumerator {
        void NotUsed1();
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice dev);
      }
      [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
      public interface IMMDevice {
        void NotUsed1();
        void NotUsed2();
        void NotUsed3();
        void NotUsed4();
        int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
      }
'@
      $e = New-Object MMDeviceEnumerator
      $ie = [IMMDeviceEnumerator]$e
      $dev = $null
      $ie.GetDefaultAudioEndpoint(0, 1, [ref]$dev) | Out-Null
      $id = $null
      $dev.GetId([ref]$id) | Out-Null
      $id
    `, 5000);
  } catch {
    return null;
  }
}

// ─── Audio Capture ──────────────────────────────────────────
// Uses PowerShell with WASAPI loopback to capture and compute RMS.
// Falls back to ffmpeg if available.

let captureChild: ChildProcess | null = null;
let captureCallback: ((level: number) => void) | null = null;

function startFfmpegCapture(onLevel: (level: number) => void): void {
  log.info('Platform', 'Starting capture via ffmpeg dshow');

  captureChild = spawn('ffmpeg', [
    '-f', 'dshow',
    '-i', 'audio=@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{00000000-0000-0000-0000-000000000000}',
    '-ac', '1',
    '-ar', '16000',
    '-f', 's16le',
    '-',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

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
    log.info('Platform', 'ffmpeg capture exited', { code });
    captureChild = null;
  });

  captureChild.on('error', (err: Error) => {
    log.error('Platform', 'ffmpeg not found — capture unavailable', { error: err.message });
    captureChild = null;
  });
}

export const capture = {
  start(onLevel: (level: number) => void): void {
    if (captureChild) {
      log.warn('Platform', 'Capture already running');
      return;
    }

    captureCallback = onLevel;
    smoothedLevel = 0;

    // Try PowerShell WASAPI loopback capture
    log.info('Platform', 'Starting WASAPI loopback capture');

    // PowerShell script that captures WASAPI loopback and outputs RMS as JSON lines
    const psScript = `
      Add-Type -AssemblyName 'NAudio' -ErrorAction SilentlyContinue
      if (-not ([System.AppDomain]::CurrentDomain.GetAssemblies() | Where-Object { $_.GetName().Name -eq 'NAudio' })) {
        # NAudio not available, try ffmpeg fallback
        Write-Error "NAudio not available"
        exit 1
      }
      $capture = New-Object NAudio.CoreAudioApi.WasapiLoopbackCapture
      $capture.DataAvailable.Add({
        param($s, $e)
        $samples = $e.BytesRecorded / 4
        if ($samples -eq 0) { return }
        $sum = 0.0
        for ($i = 0; $i -lt $e.BytesRecorded; $i += 4) {
          $sample = [BitConverter]::ToSingle($e.Buffer, $i)
          $sum += $sample * $sample
        }
        $rms = [Math]::Min(1.0, [Math]::Sqrt($sum / $samples) * 3.0)
        Write-Output "{\\"rms\\":$rms}"
      })
      $capture.StartRecording()
      while ($true) { Start-Sleep -Milliseconds 100 }
    `;

    captureChild = spawn('powershell', ['-NoProfile', '-Command', psScript], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let lineBuffer = '';

    captureChild.stdout!.on('data', (data: Buffer) => {
      if (!captureCallback) return;

      lineBuffer += data.toString();
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop()!;

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (typeof parsed.rms === 'number') {
            captureCallback(smoothRms(parsed.rms));
          }
        } catch { /* ignore */ }
      }
    });

    captureChild.stderr!.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg && msg.includes('NAudio not available')) {
        log.warn('Platform', 'NAudio not available — trying ffmpeg fallback');
        captureChild!.kill();
        startFfmpegCapture(onLevel);
      } else if (msg) {
        log.info('Platform', 'Capture', { msg });
      }
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
      captureChild.kill();
      captureChild = null;
    }
    captureCallback = null;
    smoothedLevel = 0;
  },

  isRunning(): boolean {
    return captureChild !== null && !captureChild.killed;
  },
};

// ─── Device Switching ───────────────────────────────────────
// Uses PowerShell with CoreAudio COM interop. No external modules needed.

export const devices = {
  async setOutput(deviceName: string): Promise<any> {
    log.info('Platform', 'Setting system output', { deviceName });
    try {
      // Try AudioDeviceCmdlets first (if installed)
      runPS(`
        Get-AudioDevice -List |
          Where-Object { $_.Type -eq 'Playback' -and $_.Name -like '*${ deviceName.replace(/'/g, "''") }*' } |
          Set-AudioDevice
      `);
      log.info('Platform', 'System output changed', { deviceName });
      return { ok: true, name: deviceName };
    } catch {
      try {
        // Fallback: nircmd
        execSync(`nircmd setdefaultsounddevice "${ deviceName }"`, { timeout: 5000, stdio: 'pipe' });
        return { ok: true, name: deviceName };
      } catch (e: any) {
        log.error('Platform', 'Failed to set output — install AudioDeviceCmdlets: Install-Module AudioDeviceCmdlets', { error: e.message });
        return { ok: false, error: e.message };
      }
    }
  },

  async setInput(deviceName: string): Promise<any> {
    log.info('Platform', 'Setting system input', { deviceName });
    try {
      runPS(`
        Get-AudioDevice -List |
          Where-Object { $_.Type -eq 'Recording' -and $_.Name -like '*${ deviceName.replace(/'/g, "''") }*' } |
          Set-AudioDevice
      `);
      log.info('Platform', 'System input changed', { deviceName });
      return { ok: true, name: deviceName };
    } catch (e: any) {
      log.error('Platform', 'Failed to set input', { error: e.message });
      return { ok: false, error: e.message };
    }
  },

  async resetOutput(): Promise<void> {
    // No-op on Windows — no aggregate device to get stuck on
  },
};

// ─── Volume Control ────────────────────────────────────────
// Uses PowerShell with CoreAudio COM interop for volume control.
// Windows volume keys work natively (no interception needed).

// Helper: wraps a volume adjust action with COM setup + result output
function getVolumeAdjustScript(action: string): string {
  return `
    Add-Type -TypeDefinition @'
    using System.Runtime.InteropServices;
    [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioEndpointVolume {
      void NotUsed1(); void NotUsed2(); void NotUsed3(); void NotUsed4(); void NotUsed5(); void NotUsed6();
      int SetMasterVolumeLevelScalar(float level, ref Guid ctx);
      void NotUsed7();
      int GetMasterVolumeLevelScalar(out float level);
      void NotUsed8(); void NotUsed9(); void NotUsed10(); void NotUsed11();
      int SetMute(int mute, ref Guid ctx);
      int GetMute(out int mute);
    }
    [Guid("BCDE0395-E52F-467C-8E3D-C4579291692E"), ComImport, ClassInterface(ClassInterfaceType.None)]
    public class MMDevEnum {}
    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDeviceEnumerator {
      void NotUsed1();
      int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice dev);
    }
    [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDevice {
      int Activate(ref Guid iid, int ctx, System.IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    }
'@
    $e = [IMMDeviceEnumerator](New-Object MMDevEnum)
    $dev = $null; $e.GetDefaultAudioEndpoint(0, 1, [ref]$dev) | Out-Null
    $iid = [Guid]'5CDF2C82-841E-4546-9722-0CF74078229A'
    $obj = $null; $dev.Activate([ref]$iid, 1, [System.IntPtr]::Zero, [ref]$obj) | Out-Null
    $vol = [IAudioEndpointVolume]$obj
    $level = 0.0
    ${ action }
    $vol.GetMasterVolumeLevelScalar([ref]$level) | Out-Null
    $mute = 0; $vol.GetMute([ref]$mute) | Out-Null
    Write-Output "{\\"ok\\":true,\\"volume\\":$level,\\"muted\\":$($mute -ne 0 ? 'true' : 'false')}"
  `;
}

export const volume = {
  async getDefaultOutputUID(): Promise<string | null> {
    try {
      return getDefaultOutputName();
    } catch {
      return null;
    }
  },

  async adjust(deviceUID: string, cmd: string, value?: number): Promise<any> {
    try {
      let script: string;

      switch (cmd) {
      case 'get':
        script = `
            Add-Type -TypeDefinition @'
            using System.Runtime.InteropServices;
            [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
            public interface IAudioEndpointVolume {
              void NotUsed1(); void NotUsed2(); void NotUsed3(); void NotUsed4(); void NotUsed5(); void NotUsed6();
              int SetMasterVolumeLevelScalar(float level, ref Guid ctx);
              void NotUsed7();
              int GetMasterVolumeLevelScalar(out float level);
              void NotUsed8(); void NotUsed9(); void NotUsed10(); void NotUsed11();
              int SetMute(int mute, ref Guid ctx);
              int GetMute(out int mute);
            }
            [Guid("BCDE0395-E52F-467C-8E3D-C4579291692E"), ComImport, ClassInterface(ClassInterfaceType.None)]
            public class MMDevEnum {}
            [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
            public interface IMMDeviceEnumerator {
              void NotUsed1();
              int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice dev);
            }
            [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
            public interface IMMDevice {
              int Activate(ref Guid iid, int ctx, System.IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
            }
'@
            $e = [IMMDeviceEnumerator](New-Object MMDevEnum)
            $dev = $null; $e.GetDefaultAudioEndpoint(0, 1, [ref]$dev) | Out-Null
            $iid = [Guid]'5CDF2C82-841E-4546-9722-0CF74078229A'
            $obj = $null; $dev.Activate([ref]$iid, 1, [System.IntPtr]::Zero, [ref]$obj) | Out-Null
            $vol = [IAudioEndpointVolume]$obj
            $level = 0.0; $vol.GetMasterVolumeLevelScalar([ref]$level) | Out-Null
            $mute = 0; $vol.GetMute([ref]$mute) | Out-Null
            Write-Output "{\\"ok\\":true,\\"volume\\":$level,\\"muted\\":$($mute -ne 0 ? 'true' : 'false')}"
          `;
        break;

      case 'inc':
        script = getVolumeAdjustScript(`
            $vol.GetMasterVolumeLevelScalar([ref]$level) | Out-Null
            $newLevel = [Math]::Min(1.0, $level + ${ value || 0.0625 })
            $g = [Guid]::Empty; $vol.SetMasterVolumeLevelScalar($newLevel, [ref]$g) | Out-Null
            $vol.SetMute(0, [ref]$g) | Out-Null
          `);
        break;

      case 'dec':
        script = getVolumeAdjustScript(`
            $vol.GetMasterVolumeLevelScalar([ref]$level) | Out-Null
            $newLevel = [Math]::Max(0.0, $level - ${ value || 0.0625 })
            $g = [Guid]::Empty; $vol.SetMasterVolumeLevelScalar($newLevel, [ref]$g) | Out-Null
          `);
        break;

      case 'set':
        script = getVolumeAdjustScript(`
            $g = [Guid]::Empty; $vol.SetMasterVolumeLevelScalar(${ value }, [ref]$g) | Out-Null
          `);
        break;

      case 'toggle-mute':
        script = getVolumeAdjustScript(`
            $mute = 0; $vol.GetMute([ref]$mute) | Out-Null
            $g = [Guid]::Empty; $vol.SetMute($($mute -eq 0 ? 1 : 0), [ref]$g) | Out-Null
          `);
        break;

      default:
        return { ok: false, error: `Unknown command: ${ cmd }` };
      }

      const output = runPS(script);
      try {
        return JSON.parse(output);
      } catch {
        return { ok: true };
      }
    } catch (e: any) {
      log.error('Platform', 'Volume control failed', { cmd, error: e.message });
      return { ok: false, error: e.message };
    }
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

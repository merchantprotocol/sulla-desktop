/**
 * Composable — monitor disk space for the capture directory.
 *
 * Checks available space every 10 seconds during recording.
 * Warns when low (< 1 GB), auto-stops when critical (< 200 MB).
 *
 * Reference: agent/services/LlamaCppService.ts:268-294
 */

import { ref, onUnmounted } from 'vue';

const fs = require('fs');
const os = require('os');
const path = require('path');

const LOW_THRESHOLD = 1 * 1024 * 1024 * 1024; // 1 GB
const CRITICAL_THRESHOLD = 200 * 1024 * 1024;  // 200 MB
const CHECK_INTERVAL = 10_000; // 10 seconds

function getCapturesDir(): string {
  return path.join(os.homedir(), 'sulla', 'captures');
}

function formatGB(bytes: number): string {
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

function checkSpace(dirPath: string): { available: number; total: number } | null {
  try {
    const stats = fs.statfsSync(dirPath);
    return {
      available: stats.bavail * stats.bsize,
      total: stats.blocks * stats.bsize,
    };
  } catch (err: any) {
    if (err?.code === 'ERR_METHOD_NOT_IMPLEMENTED' || err?.message?.includes('statfsSync')) {
      return null; // Not available on this platform/Node version
    }
    console.warn('[useDiskSpace] Check failed:', err.message);
    return null;
  }
}

export function useDiskSpace() {
  const availableGB = ref('');
  const isLow = ref(false);
  const isCritical = ref(false);

  let interval: ReturnType<typeof setInterval> | null = null;
  let onCriticalCallback: (() => void) | null = null;

  function update() {
    const dir = getCapturesDir();
    // Ensure the directory exists for statfs
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }

    // Verify the directory actually exists before checking space
    try {
      fs.accessSync(dir);
    } catch {
      return; // Directory doesn't exist and couldn't be created
    }

    const space = checkSpace(dir);
    if (!space) return;

    availableGB.value = formatGB(space.available);
    isLow.value = space.available < LOW_THRESHOLD;
    isCritical.value = space.available < CRITICAL_THRESHOLD;

    if (isCritical.value && onCriticalCallback) {
      onCriticalCallback();
    }
  }

  /**
   * Check if there's enough space before starting a recording.
   * Returns true if OK, false if insufficient.
   */
  function checkBeforeRecording(minBytes: number = 2 * 1024 * 1024 * 1024): { ok: boolean; message: string } {
    const dir = getCapturesDir();
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}

    const space = checkSpace(dir);
    if (!space) return { ok: true, message: '' }; // Can't check, assume OK

    if (space.available < minBytes) {
      return {
        ok: false,
        message: `Only ${formatGB(space.available)} available. Need at least ${formatGB(minBytes)} to start recording.`,
      };
    }
    return { ok: true, message: '' };
  }

  /**
   * Start monitoring disk space (call when recording starts).
   */
  function startMonitoring(onCritical?: () => void) {
    onCriticalCallback = onCritical || null;
    update(); // Check immediately
    if (interval) clearInterval(interval);
    interval = setInterval(update, CHECK_INTERVAL);
  }

  /**
   * Stop monitoring (call when recording stops).
   */
  function stopMonitoring() {
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
    onCriticalCallback = null;
    isLow.value = false;
    isCritical.value = false;
  }

  onUnmounted(stopMonitoring);

  return {
    availableGB,
    isLow,
    isCritical,
    checkBeforeRecording,
    startMonitoring,
    stopMonitoring,
  };
}

/**
 * SleepPreventionService — shared, reference-counted sleep prevention for macOS.
 *
 * Uses `caffeinate -i -s` to prevent idle + system sleep and `pmset schedule wake`
 * to wake the Mac before a scheduled event.  Multiple callers (training, heartbeat,
 * etc.) can hold the lock simultaneously; the caffeinate process is only spawned once
 * and killed when the last holder releases.
 */

import type { ChildProcess } from 'child_process';

// ── State ──

let caffeinateProcess: ChildProcess | null = null;
const activeHolders = new Set<string>();

// ── Caffeinate (sleep prevention) ──

/**
 * Acquire sleep prevention for the given label.
 * Spawns `caffeinate -i -s` on the first call; subsequent calls just add the label.
 */
export function startCaffeinate(label: string): void {
  if (process.platform !== 'darwin') return;
  activeHolders.add(label);

  if (caffeinateProcess) {
    console.log(`[SleepPrevention] +${ label } (holders: ${ [...activeHolders].join(', ') }) — caffeinate already running`);

    return;
  }

  try {
    const { spawn } = require('child_process') as typeof import('child_process');
    const proc = spawn('caffeinate', ['-i', '-s'], {
      stdio:    'ignore',
      detached: true,
    });

    proc.unref();
    caffeinateProcess = proc;
    console.log(`[SleepPrevention] caffeinate started (PID ${ proc.pid }) — holder: ${ label }`);
  } catch (err) {
    console.error('[SleepPrevention] Failed to start caffeinate:', err);
  }
}

/**
 * Release sleep prevention for the given label.
 * Kills the caffeinate process only when the last holder releases.
 */
export function stopCaffeinate(label: string): void {
  activeHolders.delete(label);

  if (activeHolders.size > 0) {
    console.log(`[SleepPrevention] -${ label } (remaining: ${ [...activeHolders].join(', ') }) — caffeinate stays`);

    return;
  }

  if (!caffeinateProcess) return;
  try {
    caffeinateProcess.kill();
    console.log(`[SleepPrevention] caffeinate stopped — last holder (${ label }) released`);
  } catch { /* already dead */ }
  caffeinateProcess = null;
}

/** Returns the set of labels currently holding sleep prevention. */
export function getActiveHolders(): ReadonlySet<string> {
  return activeHolders;
}

// ── Wake scheduling (pmset) ──

/**
 * Schedule a macOS wake event via `pmset schedule wake`.
 * Schedules the wake 2 minutes before `targetDate` so the system is ready.
 * Requires admin privileges — fails silently if not available.
 */
export function scheduleWake(targetDate: Date): void {
  if (process.platform !== 'darwin') return;
  try {
    const wake = new Date(targetDate.getTime());
    // Wake 2 minutes early so the system is ready
    wake.setMinutes(wake.getMinutes() - 2);

    if (wake <= new Date()) return; // already in the past

    const pad = (n: number) => String(n).padStart(2, '0');
    const dateStr = `${ pad(wake.getMonth() + 1) }/${ pad(wake.getDate()) }/${ wake.getFullYear() } ${ pad(wake.getHours()) }:${ pad(wake.getMinutes()) }:00`;

    const { execSync } = require('child_process') as typeof import('child_process');
    execSync(`pmset schedule wake "${ dateStr }"`, { stdio: 'pipe' });
    console.log(`[SleepPrevention] Scheduled macOS wake for ${ dateStr }`);
  } catch (err) {
    console.log(`[SleepPrevention] Could not schedule wake (pmset may need sudo): ${ err }`);
  }
}

// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

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
const chatActivityHolders = new Set<string>();
let appSuspensionBlockerId: number | null = null;

type PowerSaveBlocker = Pick<import('electron').PowerSaveBlocker, 'start' | 'stop' | 'isStarted'>;
let powerSaveBlockerOverride: PowerSaveBlocker | null = null;

/** Electron's blocker, loaded lazily so this module imports fine outside Electron. */
function getPowerSaveBlocker(): PowerSaveBlocker {
  if (powerSaveBlockerOverride) return powerSaveBlockerOverride;
  return (require('electron') as typeof import('electron')).powerSaveBlocker;
}

/** Test seam: swap in a fake powerSaveBlocker (pass null to restore). */
export function setPowerSaveBlockerForTests(blocker: PowerSaveBlocker | null): void {
  powerSaveBlockerOverride = blocker;
}

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

/**
 * Keep both macOS and Electron awake while chat work can still make progress.
 * Callers use stable, per-activity keys; duplicate acquire/release calls are
 * harmless and the two underlying assertions exist only while the set is non-empty.
 */
export function acquireChatActivity(key: string): void {
  if (!key || chatActivityHolders.has(key)) return;
  chatActivityHolders.add(key);
  if (chatActivityHolders.size > 1) {
    console.log(`[SleepPrevention] +chat:${ key } (chat holders: ${ chatActivityHolders.size })`);
    return;
  }

  startCaffeinate('chat-activity');
  try {
    appSuspensionBlockerId = getPowerSaveBlocker().start('prevent-app-suspension');
    console.log(`[SleepPrevention] prevent-app-suspension started (ID ${ appSuspensionBlockerId }) — chat:${ key }`);
  } catch (err) {
    console.error('[SleepPrevention] Failed to start prevent-app-suspension:', err);
  }
}

export function releaseChatActivity(key: string): void {
  if (!chatActivityHolders.delete(key)) return;
  if (chatActivityHolders.size > 0) {
    console.log(`[SleepPrevention] -chat:${ key } (chat holders: ${ chatActivityHolders.size })`);
    return;
  }

  stopCaffeinate('chat-activity');
  if (appSuspensionBlockerId === null) return;
  try {
    const powerSaveBlocker = getPowerSaveBlocker();
    if (powerSaveBlocker.isStarted(appSuspensionBlockerId)) powerSaveBlocker.stop(appSuspensionBlockerId);
    console.log(`[SleepPrevention] prevent-app-suspension stopped (ID ${ appSuspensionBlockerId }) — last chat holder released`);
  } catch (err) {
    console.error('[SleepPrevention] Failed to stop prevent-app-suspension:', err);
  }
  appSuspensionBlockerId = null;
}

/** Release every chat assertion during app/service teardown. */
export function releaseAllChatActivity(): void {
  for (const key of [...chatActivityHolders]) releaseChatActivity(key);
}

export function getChatActivityHolders(): ReadonlySet<string> {
  return chatActivityHolders;
}

// ── Wake scheduling (pmset) ──

/**
 * Schedule a macOS wake event.
 * `pmset schedule wake` requires root privileges which we don't have, so this
 * stays a no-op. The actual "keep the operator standing" guarantee comes from
 * HeartbeatService holding a CONTINUOUS caffeinate -i -s for the whole enabled
 * lifetime (label 'heartbeat-standing'), which prevents the inter-cycle idle
 * sleep that this wake was meant to recover from. Remaining gap (needs root):
 * caffeinate -s only asserts on AC power and does not defeat clamshell sleep.
 *
 * This is a no-op — kept for API compatibility with callers.
 */
export function scheduleWake(_targetDate: Date): void {
  // No-op — pmset requires root, caffeinate handles sleep prevention
}

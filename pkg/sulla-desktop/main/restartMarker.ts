// SPDX-License-Identifier: GPL-2.0-or-later
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'fs';
import type { App } from 'electron';
import path from 'path';

const MAX_AGE_MS = 3 * 60_000;
const LOCK_RETRY_MS = 500;
const LOCK_RETRY_LIMIT_MS = 120_000;

interface RestartMarker { pid: number; timestamp: number }

export function restartMarkerPath(userData: string): string {
  return path.join(userData, 'restart-pending.json');
}

export function writeRestartMarker(userData: string): void {
  const target = restartMarkerPath(userData);
  const temporary = `${ target }.${ process.pid }.tmp`;

  fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
  fs.writeFileSync(temporary, JSON.stringify({ pid: process.pid, timestamp: Date.now() }), { mode: 0o600 });
  fs.renameSync(temporary, target);
}

export function removeRestartMarker(userData: string): void {
  try {
    fs.unlinkSync(restartMarkerPath(userData));
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function readFreshMarker(userData: string): RestartMarker | undefined {
  try {
    const marker = JSON.parse(fs.readFileSync(restartMarkerPath(userData), 'utf8')) as RestartMarker;

    if (!Number.isSafeInteger(marker.pid) || marker.pid <= 1 || !Number.isFinite(marker.timestamp) ||
        Date.now() - marker.timestamp < 0 || Date.now() - marker.timestamp >= MAX_AGE_MS) return undefined;

    return marker;
  } catch {
    return undefined;
  }
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error: any) {
    return error?.code === 'EPERM';
  }
}

/** Retry only a restart handoff; ordinary duplicate launches still exit immediately. */
export function acquireSingleInstanceLock(app: App, userData: string): boolean {
  if (app.requestSingleInstanceLock()) {
    removeRestartMarker(userData);

    return true;
  }
  const marker = readFreshMarker(userData);

  if (!marker) return false;
  const deadline = Date.now() + LOCK_RETRY_LIMIT_MS;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));

  while (Date.now() < deadline && pidIsAlive(marker.pid)) {
    Atomics.wait(sleeper, 0, 0, LOCK_RETRY_MS);
    if (app.requestSingleInstanceLock()) {
      removeRestartMarker(userData);

      return true;
    }
  }
  // The old pid can disappear just before the OS releases its lock.
  Atomics.wait(sleeper, 0, 0, LOCK_RETRY_MS);
  if (app.requestSingleInstanceLock()) {
    removeRestartMarker(userData);

    return true;
  }

  return false;
}

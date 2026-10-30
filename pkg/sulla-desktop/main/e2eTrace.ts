// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Startup trace for the first-run Electron E2E harness. It imports nothing but
// fs and electron so it can run before the main bundle loads. Only an
// unpackaged app with SULLA_E2E=1 and SULLA_E2E_MAIN_LOG writes anything.

import fs from 'fs';

import { app } from 'electron';

const tracePath = !(app?.isPackaged ?? true) && process.env.SULLA_E2E === '1' ? process.env.SULLA_E2E_MAIN_LOG || '' : '';

/** Append one line to stderr and the harness trace file, synchronously. */
export function e2eTrace(message: string): void {
  if (!tracePath) return;
  const line = `[sulla-e2e] ${ new Date().toISOString() } pid=${ process.pid } ${ message }\n`;

  process.stderr.write(line);
  try {
    fs.appendFileSync(tracePath, line);
  } catch {}
}

/**
 * Report main-process crashes instead of letting Electron's default handler
 * open a native error box. That box blocks the main thread under xvfb, so the
 * process stays alive with no window and prints nothing.
 */
export function installE2eCrashTrace(): void {
  if (!tracePath) return;
  const describe = (error: unknown) => error instanceof Error ? error.stack || `${ error.name }: ${ error.message }` : String(error);

  process.on('uncaughtException', error => e2eTrace(`uncaughtException: ${ describe(error) }`));
  process.on('unhandledRejection', reason => e2eTrace(`unhandledRejection: ${ describe(reason) }`));
}

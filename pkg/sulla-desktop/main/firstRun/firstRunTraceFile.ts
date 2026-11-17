// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import path from 'node:path';

import Electron from 'electron';

const TRACE_NAME = 'first-run-trace.log';

/** Where the first-run timeline is written (Desktop userData). Desktop-only: Electron is required. */
export function firstRunTracePath(): string {
  return path.join(Electron.app.getPath('userData'), TRACE_NAME);
}

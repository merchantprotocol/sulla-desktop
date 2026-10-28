// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { runCommand } from '../util/CommandRunner';

import type { CommandRunnerOptions } from '../util/CommandRunner';

/** Run Docker against the daemon owned by the native Sulla runtime VM. */
export function runDockerCommand(args: string[], options: CommandRunnerOptions = {}) {
  return runCommand('docker', args, { ...options, runInGuest: true });
}

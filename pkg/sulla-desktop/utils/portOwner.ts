// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { execFile } from 'child_process';

/**
 * Which Mac process listens on a TCP port ("node (pid 123)"), for logs when
 * Sulla cannot bind it. Best effort: '' when lsof is missing or finds nothing.
 */
export function describePortOwner(port: number): Promise<string> {
  return new Promise((resolve) => {
    execFile('/usr/sbin/lsof', ['-nP', `-iTCP:${ port }`, '-sTCP:LISTEN', '-Fpc'], { timeout: 3_000 }, (_error, stdout) => {
      const pid = /^p(\d+)$/m.exec(stdout ?? '')?.[1];
      const command = /^c(.+)$/m.exec(stdout ?? '')?.[1];

      resolve(pid ? `${ command ?? 'unknown' } (pid ${ pid })` : '');
    });
  });
}

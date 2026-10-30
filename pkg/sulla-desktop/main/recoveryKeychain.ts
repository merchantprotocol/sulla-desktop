// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { spawn } from 'node:child_process';

/** Store an account recovery key as a discoverable macOS generic password. */
export async function saveRecoveryKeyToMacKeychain(accountId: string, recoveryKey: string): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('Recovery-key Keychain storage is only available on macOS');
  if (!/^[0-9a-f-]{36}$/i.test(accountId) || !/^[A-Za-z0-9_-]{43}$/.test(recoveryKey)) throw new Error('Recovery-key material is invalid');
  await new Promise<void>((resolve, reject) => {
    const child = spawn('/usr/bin/security', [
      'add-generic-password', '-U', '-s', 'Sulla recovery key', '-a', accountId, '-w',
    ], { stdio: ['pipe', 'ignore', 'pipe'] });
    child.stdin.end(`${ recoveryKey }\n`);
    let error = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { if (error.length < 512) error += chunk });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Keychain rejected the recovery key (${ code }): ${ error.trim() }`)));
  });
}

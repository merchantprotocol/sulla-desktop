// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const INSTALL_ID_FILE = 'install-id';

/** Return the anonymous UUID for this install, creating it on first use. */
export function getInstallId(userDataPath: string): string {
  const installIdPath = path.join(userDataPath, INSTALL_ID_FILE);

  try {
    const existing = fs.readFileSync(installIdPath, 'utf8').trim();

    if (existing) {
      return existing;
    }
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      throw err;
    }
  }

  const installId = crypto.randomUUID();

  fs.mkdirSync(userDataPath, { recursive: true });
  fs.writeFileSync(installIdPath, installId, { encoding: 'utf8', mode: 0o600 });

  return installId;
}

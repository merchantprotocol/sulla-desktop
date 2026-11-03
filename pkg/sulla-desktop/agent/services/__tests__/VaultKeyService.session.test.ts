/** @jest-environment node */
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sulla-vault-session-'));
const dirname = path.dirname(fileURLToPath(import.meta.url));

afterAll(async() => { await fs.rm(home, { recursive: true, force: true }) });

test('Cloud logout leaves the OS-wrapped local vault key in place', async() => {
  const wrapped = path.join(home, 'vault-v2-key.enc');
  await fs.writeFile(wrapped, 'synthetic-wrapped-session', { mode: 0o600 });

  const authSource = await fs.readFile(path.join(dirname, '../../../main/sullaCloudAuth.ts'), 'utf8');
  const logoutHandler = authSource.slice(
    authSource.indexOf("ipcMainProxy.handle('sulla-cloud:logout'"),
    authSource.indexOf('// Auto-pair relay on startup'),
  );

  expect(logoutHandler).not.toContain('VaultKeyService');
  expect(logoutHandler).not.toContain('vault-v2-key.enc');
  await expect(fs.readFile(wrapped, 'utf8')).resolves.toBe('synthetic-wrapped-session');
});

/** @jest-environment node */
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { jest } from '@jest/globals';

import mockModules from '@pkg/utils/testUtils/mockModules';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sulla-vault-session-'));
const lock = jest.fn(async() => ({ state: 'locked', unlocked: false }));
const markLocked = jest.fn();

mockModules({
  electron: { app: { getAppPath: () => home }, default: { app: { getAppPath: () => home } } },
  '@pkg/utils/paths': { default: { appHome: home, sullaConfig: path.join(home, 'config') } },
  '../DesktopVaultClient': { getDesktopVaultClient: () => ({ lock, markLocked }) },
});

const { VaultKeyService } = await import('../VaultKeyService');

afterAll(async() => { await fs.rm(home, { recursive: true, force: true }) });

test('logout locks the vault and removes the OS-wrapped auto-unlock session', async() => {
  const wrapped = path.join(home, 'vault-v2-key.enc');
  await fs.writeFile(wrapped, 'synthetic-wrapped-session', { mode: 0o600 });

  await new VaultKeyService().clearSignedInSession();

  expect(markLocked).toHaveBeenCalledTimes(1);
  expect(lock).toHaveBeenCalledTimes(1);
  await expect(fs.stat(wrapped)).rejects.toMatchObject({ code: 'ENOENT' });
});

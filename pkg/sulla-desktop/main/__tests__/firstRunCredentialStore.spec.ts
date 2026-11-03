// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, describe, expect, jest, test } from '@jest/globals';

let row: any;
const query = jest.fn(async(sql: string, params: any[] = []) => {
  if (sql.includes('INSERT INTO first_run_credentials')) {
    row = { integration_id: params[0], account_id: params[1], encrypted_payload: JSON.parse(params[2]), key_id: params[3] };
    return [];
  }
  if (sql.includes('SELECT integration_id')) return row ? [row] : [];
  if (sql.includes('DELETE FROM first_run_credentials')) row = undefined;
  return [];
});
const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-first-run-store-'));

jest.unstable_mockModule('../../agent/database/PostgresClient', () => ({ postgresClient: { query } }));
jest.unstable_mockModule('../../backend/sullaRuntime/artifacts', () => ({ sullaRuntimeDirectory: () => runtimeDir }));

afterEach(() => { row = undefined; query.mockClear() });
afterAll(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));

describe('first-run credential store', () => {
  test('decrypts a queued credential after the module cache is reset', async() => {
    const first = await import('../firstRun/firstRunCredentialStore');
    await first.storeFirstRunCredential({ integrationId: 'codex', accountId: 'oauth', values: { access_token: 'restart-secret' }, activate: true });

    expect(JSON.stringify(row)).not.toContain('restart-secret');
    expect(row.encrypted_payload).toEqual({ ciphertext: expect.any(String), nonce: expect.any(String) });
    expect(fs.statSync(first.firstRunCredentialKeyPath()).mode & 0o777).toBe(0o600);

    jest.resetModules();
    const restarted = await import('../firstRun/firstRunCredentialStore');
    await expect(restarted.loadFirstRunCredentials()).resolves.toEqual([
      { integrationId: 'codex', accountId: 'oauth', values: { access_token: 'restart-secret' }, activate: true },
    ]);
  });
});

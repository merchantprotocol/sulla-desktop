// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import * as fs from 'fs';
import * as nodeOs from 'node:os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const ensureFreshTokensMock: any = jest.fn();
const getStoredTokensMock: any = jest.fn();
let tempHome = '';
let containerAuthority = false;

jest.unstable_mockModule('os', () => ({
  homedir: () => tempHome,
}));

jest.unstable_mockModule('../../services/OAuthService', () => ({
  getOAuthService: () => ({
    ensureFreshTokens: ensureFreshTokensMock,
    getStoredTokens:   getStoredTokensMock,
  }),
}));

jest.unstable_mockModule('../../services/IntegrationService', () => ({
  getIntegrationService: () => ({
    getActiveAccountId: jest.fn(() => Promise.resolve('oauth')),
  }),
}));

jest.unstable_mockModule('../../../vault-broker', () => ({
  usesContainerVaultAuthority: () => containerAuthority,
}));

function jwtWithExpiry(expiresAtMs: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(expiresAtMs / 1000) })).toString('base64url');

  return `${ header }.${ payload }.signature`;
}

describe('codexAuthFile', () => {
  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(nodeOs.tmpdir(), 'codex-auth-file-'));
    ensureFreshTokensMock.mockReset();
    getStoredTokensMock.mockReset();
    containerAuthority = false;
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
    tempHome = '';
  });

  it('keeps a fresh Codex auth file without touching OAuth storage', async() => {
    const { ensureCodexAuthFile, writeCodexAuthFile, codexAuthPath } = await import('../codexAuthFile');

    expect(writeCodexAuthFile({
      access_token: jwtWithExpiry(Date.now() + 60 * 60 * 1000),
      token_type:   'Bearer',
    })).toBe(true);

    await expect(ensureCodexAuthFile()).resolves.toBe(true);
    expect(ensureFreshTokensMock).not.toHaveBeenCalled();

    const saved = JSON.parse(fs.readFileSync(codexAuthPath(), 'utf-8'));
    expect(saved.tokens.access_token).toBeTruthy();
  });

  it('writes a missing Codex auth file from fresh OAuth tokens before spawn', async() => {
    const { ensureCodexAuthFile, codexAuthPath } = await import('../codexAuthFile');
    const freshAccessToken = jwtWithExpiry(Date.now() + 60 * 60 * 1000);

    ensureFreshTokensMock.mockResolvedValueOnce({
      access_token:  freshAccessToken,
      refresh_token: 'refresh-token',
      token_type:    'Bearer',
    });

    await expect(ensureCodexAuthFile()).resolves.toBe(true);

    expect(ensureFreshTokensMock).toHaveBeenCalledWith('codex', 'oauth');
    const saved = JSON.parse(fs.readFileSync(codexAuthPath(), 'utf-8'));
    expect(saved.tokens.access_token).toBe(freshAccessToken);
    expect(saved.tokens.refresh_token).toBe('refresh-token');
  });

  it('refreshes OAuth tokens before spawning Codex when the auth file is stale', async() => {
    const { ensureCodexAuthFile, writeCodexAuthFile, codexAuthPath } = await import('../codexAuthFile');
    const freshAccessToken = jwtWithExpiry(Date.now() + 60 * 60 * 1000);

    expect(writeCodexAuthFile({
      access_token: jwtWithExpiry(Date.now() - 60 * 1000),
      token_type:   'Bearer',
    })).toBe(true);
    ensureFreshTokensMock.mockResolvedValueOnce({
      access_token:  freshAccessToken,
      refresh_token: 'refresh-token',
      token_type:    'Bearer',
    });

    await expect(ensureCodexAuthFile()).resolves.toBe(true);

    expect(ensureFreshTokensMock).toHaveBeenCalledWith('codex', 'oauth');
    const saved = JSON.parse(fs.readFileSync(codexAuthPath(), 'utf-8'));
    expect(saved.tokens.access_token).toBe(freshAccessToken);
    expect(saved.tokens.refresh_token).toBe('refresh-token');
  });

  it('accepts metadata-only vault exchange results without writing or linking credentials', async() => {
    containerAuthority = true;
    const { codexAuthPath, ensureCodexAuthFile, prepareCodexAuthAfterExchange } = await import('../codexAuthFile');

    await expect(prepareCodexAuthAfterExchange({
      token_type: 'Bearer',
      expires_at: Date.now() + 60 * 60 * 1000,
    }, true)).resolves.toEqual({ custody: 'vault-bridge', written: false, linked: false });
    await expect(ensureCodexAuthFile()).resolves.toBe(true);

    expect(fs.existsSync(codexAuthPath())).toBe(false);
    expect(ensureFreshTokensMock).not.toHaveBeenCalled();
    expect(getStoredTokensMock).not.toHaveBeenCalled();
  });

  it('keeps a raw-token sign-in durable when the guest is not ready for linking', async() => {
    const { codexAuthPath, ensureCodexAuthFile, prepareCodexAuthAfterExchange } = await import('../codexAuthFile');
    const accessToken = jwtWithExpiry(Date.now() + 60 * 60 * 1000);

    await expect(prepareCodexAuthAfterExchange({
      access_token: accessToken,
      token_type:   'Bearer',
    }, false, async() => false)).resolves.toEqual({ custody: 'auth-file', written: true, linked: false });

    expect(JSON.parse(fs.readFileSync(codexAuthPath(), 'utf-8')).tokens.access_token).toBe(accessToken);
    await expect(ensureCodexAuthFile()).resolves.toBe(true);
    expect(ensureFreshTokensMock).not.toHaveBeenCalled();
  });

  it('rejects a raw-token exchange when no local credential can be written', async() => {
    const { codexAuthPath, prepareCodexAuthAfterExchange } = await import('../codexAuthFile');

    await expect(prepareCodexAuthAfterExchange({ token_type: 'Bearer' }, false))
      .rejects.toThrow('credentials could not be prepared locally');
    expect(fs.existsSync(codexAuthPath())).toBe(false);
  });
});

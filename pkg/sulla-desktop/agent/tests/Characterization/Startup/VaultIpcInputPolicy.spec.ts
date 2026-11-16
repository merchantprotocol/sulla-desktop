// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// Characterization of the vault/accounts IPC input checks moved out of
// sulla.ts. risk: permissions (untrusted renderer frames reaching vault
// metadata or Accounts), and secret egress through the legacy channels.

import { describe, expect, it } from 'vitest';

import { VaultIpcInputPolicy } from '../../../../main/startup/VaultIpcInputPolicy';

const mainFrame = { id: 'main-frame' };
const webContents = { mainFrame };
const mainWindow = { webContents } as unknown as Electron.BrowserWindow;
const policyWith = (window: Electron.BrowserWindow | null) => new VaultIpcInputPolicy({ getWindow: name => name === 'main-agent' ? window : null });

describe('VaultIpcInputPolicy caller trust', () => {
  it('accepts only the main window top frame for vault metadata', () => {
    const policy = policyWith(mainWindow);

    expect(() => policy.requireTrustedVaultRenderer({ sender: webContents, senderFrame: mainFrame })).not.toThrow();
    expect(() => policy.requireTrustedVaultRenderer({ sender: webContents, senderFrame: { id: 'iframe' } })).toThrow('Untrusted vault metadata caller');
    expect(() => policy.requireTrustedVaultRenderer({ sender: {}, senderFrame: mainFrame })).toThrow('Untrusted vault metadata caller');
  });

  it('refuses vault metadata when the main window does not exist', () => {
    expect(() => policyWith(null).requireTrustedVaultRenderer({ sender: undefined, senderFrame: undefined })).toThrow('Untrusted vault metadata caller');
  });

  it('accepts only the main window top frame for Accounts', () => {
    const policy = policyWith(mainWindow);

    expect(() => policy.requireTrustedAccountsRenderer({ sender: webContents, senderFrame: mainFrame })).not.toThrow();
    expect(() => policy.requireTrustedAccountsRenderer({ sender: webContents, senderFrame: { id: 'iframe' } })).toThrow('Untrusted Accounts caller');
    expect(() => policyWith(null).requireTrustedAccountsRenderer({ sender: webContents, senderFrame: mainFrame })).toThrow('Untrusted Accounts caller');
  });

  it('keeps the legacy secret channels closed', () => {
    expect(() => policyWith(mainWindow).denyLegacyVaultIpc()).toThrow('unsupported_secret_egress: use the isolated vault window');
  });
});

describe('VaultIpcInputPolicy.metadataId', () => {
  const policy = policyWith(mainWindow);

  it('accepts well-formed integration and account ids', () => {
    expect(policy.metadataId('github', 'integrationId')).toBe('github');
    expect(policy.metadataId('acct:1.a-b_c', 'integrationId')).toBe('acct:1.a-b_c');
    expect(policy.metadataId('me+work@example.com', 'accountId')).toBe('me+work@example.com');
  });

  it('rejects ids that are not strings, start with punctuation, carry path characters or are too long', () => {
    expect(() => policy.metadataId(42, 'integrationId')).toThrow('Invalid integrationId');
    expect(() => policy.metadataId('-github', 'integrationId')).toThrow('Invalid integrationId');
    expect(() => policy.metadataId('../etc', 'accountId')).toThrow('Invalid accountId');
    expect(() => policy.metadataId('me@example.com', 'integrationId')).toThrow('Invalid integrationId');
    expect(() => policy.metadataId('a'.repeat(129), 'integrationId')).toThrow('Invalid integrationId');
    expect(policy.metadataId('a'.repeat(128), 'integrationId')).toHaveLength(128);
    expect(() => policy.metadataId('a'.repeat(193), 'accountId')).toThrow('Invalid accountId');
  });
});

describe('VaultIpcInputPolicy.sanitizeConnectSpec', () => {
  const policy = policyWith(mainWindow);

  it('returns nothing for a missing or non-object spec', () => {
    expect(policy.sanitizeConnectSpec(undefined)).toBeUndefined();
    expect(policy.sanitizeConnectSpec('spec')).toBeUndefined();
  });

  it('keeps only layout fields, drops values and unsafe keys, and caps lengths and counts', () => {
    const spec = policy.sanitizeConnectSpec({
      name:   'N'.repeat(500),
      value:  'sk-secret',
      fields: [
        { key: 'api_key', title: 'API key', type: 'password', required: true, value: 'sk-secret', placeholder: 'sk-…' },
        { key: 'bad key!', title: 'dropped' },
        { key: 'url', type: 'script' },
        ...Array.from({ length: 30 }, (_, i) => ({ key: `f${ i }` })),
      ],
      guide: { title: 'How', steps: [{ title: 'One', content: 'Do it', secret: 'x' }], notes: ['note', 7] },
    })!;

    expect(spec.name).toHaveLength(120);
    expect(JSON.stringify(spec)).not.toContain('sk-secret');
    expect(spec.fields[0]).toEqual({ key: 'api_key', title: 'API key', hint: '', type: 'password', required: true, placeholder: 'sk-…' });
    expect(spec.fields.map(f => f.key)).not.toContain('bad key!');
    expect(spec.fields[1]).toMatchObject({ key: 'url', type: 'text', required: false });
    // The first 20 fields are considered; invalid ones are then removed.
    expect(spec.fields).toHaveLength(19);
    expect(spec.guide.steps).toEqual([{ title: 'One', content: 'Do it' }]);
    expect(spec.guide.notes).toEqual(['note', '']);
  });
});

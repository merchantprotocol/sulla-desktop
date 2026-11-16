// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {},
  safeStorage: { isEncryptionAvailable: () => true, decryptString: () => '' },
  session: { fromPartition: () => ({}) },
  default: {},
}));

import { VaultTlsPinService } from '../../../../main/vaultTls';
import { DesktopVaultIdentityRepository } from '../../../../vault-broker/desktopTransport';
import { ToolsVaultTransport } from '../../../../vault-broker/toolsTransport';

const GOOD_PIN = 'AB'.repeat(32);

function fakeSession() {
  const verifiers: Array<(request: unknown, callback: (code: number) => void) => void> = [];

  return {
    verifiers,
    setCertificateVerifyProc: vi.fn((proc: (request: unknown, callback: (code: number) => void) => void) => { verifiers.push(proc) }),
  };
}

describe('VaultTlsPinService', () => {
  it('fails closed while the pin is unreadable', async() => {
    // risk: authorization — with no valid pin, every vault certificate is rejected (-2).
    const pins = new VaultTlsPinService(async() => 'not-a-fingerprint');
    const session = fakeSession();

    await expect(pins.configureSession(session as never)).rejects.toThrow('Vault TLS fingerprint is missing or invalid');
    const failClosed: number[] = [];
    session.verifiers[0]({}, code => failClosed.push(code));
    expect(failClosed).toEqual([-2]);
  });

  it('pins a session once and re-pins it on refresh', async() => {
    // risk: authorization — after provisioning republishes the pin, existing sessions must use the new one.
    let pin = GOOD_PIN.toLowerCase();
    const pins = new VaultTlsPinService(async() => pin);
    const session = fakeSession();

    await pins.configureSession(session as never);
    pin = 'CD'.repeat(32);
    await pins.refresh();
    // Two verifier updates per pinned session: the fail-closed guard, then the pinned verifier. Refresh repeats both.
    expect(session.setCertificateVerifyProc).toHaveBeenCalledTimes(4);
  });
});

describe('DesktopVaultIdentityRepository', () => {
  it('reports a missing identity file as a startup state, not a crash', async() => {
    // risk: availability — before the runtime writes identities, the error tells the human to wait.
    const enoent = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const repository = new DesktopVaultIdentityRepository(
      () => ({ isEncryptionAvailable: () => true, decryptString: () => 'token' }) as never,
      () => '/app-home',
      async() => { throw enoent },
    );

    await expect(repository.loadBrokerIdentity()).rejects.toThrow('still starting its password vault');
  });

  it('returns the decrypted service identity for the requested service', async() => {
    // risk: authorization — the broker identity carries its own service id, never another service's.
    const repository = new DesktopVaultIdentityRepository(
      () => ({ isEncryptionAvailable: () => true, decryptString: () => 'service-token' }) as never,
      () => '/app-home',
      async() => Buffer.from('encrypted'),
    );

    await expect(repository.loadBrokerIdentity()).resolves.toEqual({ serviceId: 'sulla-tools', serviceToken: 'service-token' });
    await expect(repository.loadApprovalIdentity()).resolves.toEqual({ serviceId: 'sulla-desktop-approval', serviceToken: 'service-token' });
  });

  it('refuses to load when OS key storage is unavailable', async() => {
    // risk: secret disclosure — no identity is read without OS-protected storage.
    const repository = new DesktopVaultIdentityRepository(() => ({ isEncryptionAvailable: () => false }) as never, () => '/app-home', async() => Buffer.from(''));

    await expect(repository.loadBrokerIdentity()).rejects.toThrow('OS-protected vault service identity is unavailable');
  });
});

describe('ToolsVaultTransport', () => {
  it('requires the mounted CA file before it opens any connection', async() => {
    // risk: authorization — the tools transport never falls back to an unpinned connection.
    const transport = new ToolsVaultTransport(() => undefined);

    await expect(transport.fetch('https://vault/x', {})).rejects.toThrow('SULLA_VAULT_TLS_CA_FILE is required');
  });
});

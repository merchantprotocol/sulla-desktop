// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GuestTlsIdentityProvisioner } from './GuestTlsIdentityProvisioner';

// A throwaway self-signed certificate, generated per test, stands in for the guest's PEM output.
function selfSignedPem(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tls-pem-'));

  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=test'], { stdio: 'ignore' });

    return fs.readFileSync(path.join(dir, 'c.pem'), 'utf8');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('GuestTlsIdentityProvisioner', () => {
  let home: string;
  let pem: string;
  let guest: { execCommand: ReturnType<typeof vi.fn>; writeFile: ReturnType<typeof vi.fn> };
  let sessions: { refreshVault: ReturnType<typeof vi.fn>; refreshFiles: ReturnType<typeof vi.fn> };
  let provisioner: GuestTlsIdentityProvisioner;

  beforeEach(async() => {
    home = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tls-home-'));
    pem = selfSignedPem();
    guest = {
      execCommand: vi.fn(async(options: { capture?: boolean }) => (options.capture ? pem : undefined)),
      writeFile:   vi.fn(async() => undefined),
    };
    sessions = { refreshVault: vi.fn(async() => undefined), refreshFiles: vi.fn(async() => undefined) };
    provisioner = new GuestTlsIdentityProvisioner(guest as any, { vault: 'VAULT-SCRIPT', files: 'FILES-SCRIPT' }, sessions, () => home);
  });
  afterEach(async() => {
    vi.restoreAllMocks();
    await fs.promises.rm(home, { recursive: true, force: true });
  });

  it('fails clearly when the guest has no openssl, without running the script', async() => {
    guest.execCommand.mockImplementationOnce(async() => { throw new Error('exit 1') });
    await expect(provisioner.prepareVaultTlsIdentity()).rejects.toThrow('has no openssl');
    expect(guest.execCommand).toHaveBeenCalledTimes(1);
    expect(sessions.refreshVault).not.toHaveBeenCalled();
  });

  // risk: permissions — only the public certificate is published; host copies are 0600.
  it('publishes the vault certificate, records its fingerprint and refreshes pinned sessions', async() => {
    const { fingerprint } = await provisioner.prepareVaultTlsIdentity();

    expect(fingerprint).toBe(new crypto.X509Certificate(pem).fingerprint256);
    expect(guest.execCommand).toHaveBeenCalledWith({ capture: true, root: true }, 'sh', '-c', 'VAULT-SCRIPT', '--',
      expect.any(String), '/var/lib/sulla/vault-tls', '1000', '1000');
    expect(guest.writeFile).toHaveBeenCalledWith('/etc/sulla-console/vault.crt', pem, 0o644);
    expect(fs.readFileSync(path.join(home, 'vault-tls-fingerprint'), 'utf8')).toBe(`${ fingerprint }\n`);
    expect(fs.statSync(path.join(home, 'vault-tls-certificate.pem')).mode & 0o777).toBe(0o600);
    expect(sessions.refreshVault).toHaveBeenCalledOnce();
    expect(sessions.refreshFiles).not.toHaveBeenCalled();
  });

  it('provisions the Files identity for the host user and refreshes the Files sessions', async() => {
    // A fixed host user keeps this deterministic in containers with no passwd entry (userInfo throws ENOENT there).
    vi.spyOn(os, 'userInfo').mockReturnValue({ uid: 501, gid: 20, username: 'u', homedir: '/h', shell: null } as any);
    const { fingerprint } = await provisioner.prepareFilesTlsIdentity();

    expect(guest.execCommand).toHaveBeenCalledWith({ capture: true, root: true }, 'sh', '-c', 'FILES-SCRIPT', '--',
      expect.any(String), '501', '20');
    expect(guest.writeFile).toHaveBeenCalledWith('/etc/sulla-console/files.crt', pem, 0o644);
    expect(fs.readFileSync(path.join(home, 'files-tls-fingerprint'), 'utf8')).toBe(`${ fingerprint }\n`);
    expect(sessions.refreshFiles).toHaveBeenCalledOnce();
  });
});

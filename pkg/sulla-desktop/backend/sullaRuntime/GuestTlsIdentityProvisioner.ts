// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { VMExecutor } from '../backend';
import { FILES_TLS_DIRECTORY } from '../filesTlsIdentity';
import { VAULT_TLS_DIRECTORY } from '../vaultTlsIdentity';

export interface TlsProvisionScripts {
  vault: string;
  files: string;
}

export interface PinnedSessionRefresher {
  refreshVault(): Promise<void>;
  refreshFiles(): Promise<void>;
}

/**
 * Creates the vault and Files TLS identities inside the guest, publishes the
 * public certificates for the console proxy and the host, and refreshes the
 * pinned sessions. Extracted unchanged from SullaRuntimeBackend.
 */
export class GuestTlsIdentityProvisioner {
  constructor(
    private readonly guest: Pick<VMExecutor, 'execCommand' | 'writeFile'>,
    private readonly scripts: TlsProvisionScripts,
    private readonly pinnedSessions: PinnedSessionRefresher,
    private readonly appHome: () => string,
  ) {}

  /**
   * Run a TLS identity script (stdout is the public certificate). The Sulla
   * runtime guest may lack openssl; there the same script runs in a throwaway
   * Alpine container that sees only Sulla's guest state directories, so the
   * private key still never leaves the guest disk.
   */
  async provisionGuestTlsIdentity(script: string, ...args: string[]): Promise<string> {
    // openssl ships in the runtime guest image; the guest cannot install packages.
    const hasOpenssl = await this.guest.execCommand({ root: true, expectFailure: true }, 'sh', '-c', 'command -v openssl >/dev/null').then(() => true, () => false);
    if (!hasOpenssl) {
      throw new Error('The Sulla runtime guest has no openssl, so it cannot create its TLS identities. Update Sulla Desktop to a runtime that includes it.');
    }

    return await this.guest.execCommand({ capture: true, root: true }, 'sh', '-c', script, '--', ...args);
  }

  async prepareVaultTlsIdentity(): Promise<{ fingerprint: string }> {
    const certificate = await this.provisionGuestTlsIdentity(
      this.scripts.vault, VAULT_TLS_DIRECTORY, '/var/lib/sulla/vault-tls', '1000', '1000',
    );
    const fingerprint = new crypto.X509Certificate(certificate).fingerprint256;
    // The identity directory is 0700 and contains a private key. Publish only
    // the public certificate for the unprivileged native console proxy.
    await this.guest.execCommand({ root: true }, 'mkdir', '-p', '-m', '755', '/etc/sulla-console');
    await this.guest.writeFile('/etc/sulla-console/vault.crt', certificate, 0o644);
    await fs.promises.mkdir(this.appHome(), { recursive: true });
    await fs.promises.writeFile(path.join(this.appHome(), 'vault-tls-certificate.pem'), certificate, { mode: 0o600 });
    await fs.promises.writeFile(path.join(this.appHome(), 'vault-tls-fingerprint'), `${ fingerprint }\n`, { mode: 0o600 });

    await this.pinnedSessions.refreshVault();

    return { fingerprint };
  }

  async prepareFilesTlsIdentity(): Promise<{ fingerprint: string }> {
    const { uid, gid } = os.userInfo();
    const certificate = await this.provisionGuestTlsIdentity(this.scripts.files, FILES_TLS_DIRECTORY, String(uid), String(gid));
    const fingerprint = new crypto.X509Certificate(certificate).fingerprint256;
    await this.guest.execCommand({ root: true }, 'mkdir', '-p', '-m', '755', '/etc/sulla-console');
    await this.guest.writeFile('/etc/sulla-console/files.crt', certificate, 0o644);
    await fs.promises.mkdir(this.appHome(), { recursive: true });
    await fs.promises.writeFile(path.join(this.appHome(), 'files-tls-certificate.pem'), certificate, { mode: 0o600 });
    await fs.promises.writeFile(path.join(this.appHome(), 'files-tls-fingerprint'), `${ fingerprint }\n`, { mode: 0o600 });
    await this.pinnedSessions.refreshFiles();
    return { fingerprint };
  }
}

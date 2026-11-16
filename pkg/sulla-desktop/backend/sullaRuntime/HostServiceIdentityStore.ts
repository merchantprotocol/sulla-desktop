// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/** The OS-protected storage Electron exposes as safeStorage. */
export interface ProtectedStorage {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface VaultServiceIdentities {
  bootstrapToken: string; controlToken: string; approvalToken: string; brokerToken: string; filesToken: string;
}

export interface AccountsSecretPaths {
  bootstrap:        string;
  databasePassword: string;
  databaseUsername: string;
  encryption:       string;
  session:          string;
}

/**
 * Host-side service identities for the Sulla runtime: the vault role tokens and
 * the Files bootstrap token (safeStorage ciphertext under the app home), and the
 * Accounts secret files (0600 files in a 0700 directory). Extracted unchanged
 * from SullaRuntimeBackend.
 */
export class HostServiceIdentityStore {
  constructor(
    private readonly storage: () => ProtectedStorage,
    private readonly appHome: () => string,
  ) {}

  async loadOrCreateVaultServiceIdentities(): Promise<VaultServiceIdentities> {
    bootstrapToken: string; controlToken: string; approvalToken: string; brokerToken: string; filesToken: string;
  }> {
    if (!this.storage().isEncryptionAvailable()) {
      throw new Error('OS-protected storage is required for the local vault service identities');
    }
    const files = {
      bootstrapToken: 'vault-bootstrap-identity.enc',
      controlToken:   'vault-control-token.enc',
      approvalToken:  'vault-approval-token.enc',
      brokerToken:    'vault-broker-token.enc',
      filesToken:     'vault-files-token.enc',
    } as const;
    await fs.promises.mkdir(this.appHome(), { recursive: true });
    const readProtected = async(file: string): Promise<string | undefined> => {
      try {
        const value = this.storage().decryptString(await fs.promises.readFile(path.join(this.appHome(), file)));
        return value.length >= 32 ? value : undefined;
      } catch {
        return undefined;
      }
    };
    let identities = {
      bootstrapToken: await readProtected(files.bootstrapToken),
      controlToken:   await readProtected(files.controlToken),
      approvalToken:  await readProtected(files.approvalToken),
      brokerToken:    await readProtected(files.brokerToken),
      filesToken:     await readProtected(files.filesToken),
    };
    if (Object.values(identities).some(value => !value) || new Set(Object.values(identities)).size !== 5) {
      identities = {
        bootstrapToken: crypto.randomBytes(48).toString('base64url'),
        controlToken:   crypto.randomBytes(48).toString('base64url'),
        approvalToken:  crypto.randomBytes(48).toString('base64url'),
        brokerToken:    crypto.randomBytes(48).toString('base64url'),
        filesToken:     crypto.randomBytes(48).toString('base64url'),
      };
    }
    const writeProtected = async(file: string, value: string): Promise<void> => {
      const target = path.join(this.appHome(), file);
      const temporary = `${ target }.${ process.pid }.tmp`;
      await fs.promises.writeFile(temporary, this.storage().encryptString(value), { mode: 0o600 });
      await fs.promises.rename(temporary, target);
    };
    // Repair every exported role identity on every start. These files contain
    // only safeStorage ciphertext and are never mounted into a container.
    await writeProtected(files.bootstrapToken, identities.bootstrapToken!);
    await writeProtected(files.controlToken, identities.controlToken!);
    await writeProtected(files.approvalToken, identities.approvalToken!);
    await writeProtected(files.brokerToken, identities.brokerToken!);
    await writeProtected(files.filesToken, identities.filesToken!);

    return identities as VaultServiceIdentities;
  }

  async loadOrCreateFilesBootstrapIdentity(): Promise<string> {
    if (!this.storage().isEncryptionAvailable()) throw new Error('OS-protected storage is required for Files bootstrap');
    const target = path.join(this.appHome(), 'files-bootstrap-identity.enc');
    let encrypted:Buffer;
    try {
      encrypted = await fs.promises.readFile(target);
      const token = this.storage().decryptString(encrypted);
      if (Buffer.byteLength(token) < 32) throw new Error('Existing Files bootstrap identity is invalid');
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const token = crypto.randomBytes(48).toString('base64url');
    await fs.promises.mkdir(this.appHome(), { recursive: true });
    const temporary = `${ target }.${ process.pid }.tmp`;
    const protectedToken = this.storage().encryptString(token);
    try {
      const file = await fs.promises.open(temporary, 'wx', 0o600);
      try { await file.writeFile(protectedToken); await file.sync() } finally { await file.close() }
      try { await fs.promises.link(temporary, target) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const concurrent = this.storage().decryptString(await fs.promises.readFile(target));
        if (Buffer.byteLength(concurrent) < 32) throw new Error('Concurrent Files bootstrap identity is invalid');
        return concurrent;
      }
      const directory = await fs.promises.open(path.dirname(target), fs.constants.O_RDONLY);
      try { await directory.sync() } finally { await directory.close() }
    } finally {
      protectedToken.fill(0);
      await fs.promises.unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error });
    }
    return token;
  }

  async prepareAccountsSecrets(databasePassword: string): Promise<AccountsSecretPaths> {
    bootstrap:        string;
    databasePassword: string;
    databaseUsername: string;
    encryption:       string;
    session:          string;
  }> {
    const directory = path.join(this.appHome(), 'accounts');

    const directoryInfo = await fs.promises.lstat(directory).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (directoryInfo?.isSymbolicLink() || (directoryInfo && !directoryInfo.isDirectory())) {
      throw new Error('Accounts secret directory is not a regular directory');
    }
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.promises.chmod(directory, 0o700);

    const writeAtomic = async(target: string, value: Buffer | string):Promise<void> => {
      const targetInfo = await fs.promises.lstat(target).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      });
      if (targetInfo?.isSymbolicLink() || (targetInfo && !targetInfo.isFile())) {
        throw new Error(`Accounts secret path is not a regular file: ${ path.basename(target) }`);
      }
      const temporary = `${ target }.${ process.pid }.${ crypto.randomUUID() }.tmp`;
      const handle = await fs.promises.open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(value);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await fs.promises.rename(temporary, target);
        await fs.promises.chmod(target, 0o600);
      } finally {
        await fs.promises.unlink(temporary).catch(error => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        });
      }
    };
    const loadExisting = async(target: string):Promise<Buffer | undefined> => {
      let handle:fs.promises.FileHandle;
      try {
        handle = await fs.promises.open(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
      try {
        const info = await handle.stat();
        if (!info.isFile()) throw new Error(`Accounts secret path is not a regular file: ${ path.basename(target) }`);
        await handle.chmod(0o600);
        return await handle.readFile();
      } finally {
        await handle.close();
      }
    };
    const loadOrCreateRaw = async(name: string, bytes: number):Promise<string> => {
      const target = path.join(directory, name);
      const existing = await loadExisting(target);
      if (existing) {
        if (existing.byteLength !== bytes) throw new Error(`Existing Accounts ${ name } has an invalid length`);
      } else {
        const secret = crypto.randomBytes(bytes);
        try { await writeAtomic(target, secret) } finally { secret.fill(0) }
      }
      return target;
    };
    const loadOrCreateBearer = async(name: string):Promise<string> => {
      const target = path.join(directory, name);
      const existing = await loadExisting(target);
      if (existing) {
        const value = existing.toString('utf8').trim();
        if (!/^[A-Za-z0-9_-]{64}$/.test(value)) throw new Error(`Existing Accounts ${ name } has an invalid format`);
      } else {
        const secret = crypto.randomBytes(48).toString('base64url');
        await writeAtomic(target, secret);
      }
      return target;
    };
    const databaseUsername = path.join(directory, 'database.username');
    const databasePasswordPath = path.join(directory, 'database.password');

    await writeAtomic(databaseUsername, 'sulla');
    await writeAtomic(databasePasswordPath, databasePassword);

    return {
      bootstrap:         await loadOrCreateBearer('bootstrap.secret'),
      databasePassword: databasePasswordPath,
      databaseUsername,
      encryption:        await loadOrCreateRaw('encryption.key', 32),
      session:           await loadOrCreateRaw('session.secret', 48),
    };
  }
}

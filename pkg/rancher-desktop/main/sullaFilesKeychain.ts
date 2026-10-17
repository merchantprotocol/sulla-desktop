import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Electron safeStorage delegates encryption to the OS credential store. */
export interface FilesSafeStorage {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

/** Never retains a plaintext key after the authenticated bootstrap completes. */
export class SullaFilesKeychain {
  private opening?: Promise<void>;

  constructor(
    private readonly keyPath: string,
    private readonly storage: () => Promise<FilesSafeStorage>,
    private readonly bootstrap: (key: Buffer) => Promise<void>,
  ) {}

  unlock(): Promise<void> {
    this.opening ??= this.open().finally(() => { this.opening = undefined });
    return this.opening;
  }

  async settled(): Promise<void> {
    await this.opening?.catch(() => undefined);
  }

  private async open(): Promise<void> {
    let key: Buffer | undefined;
    try {
      const storage = await this.storage();
      if (!storage.isEncryptionAvailable() || storage.getSelectedStorageBackend?.() === 'basic_text') {
        throw new Error('Secure OS key storage is unavailable');
      }
      await fs.promises.mkdir(path.dirname(this.keyPath), { recursive: true, mode: 0o700 });
      try {
        const file = await fs.promises.open(this.keyPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          const info = await file.stat();
          if (!info.isFile() || info.size > 16_384) throw new Error('Invalid encrypted key');
          const encoded = storage.decryptString(await file.readFile());
          if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) throw new Error('Invalid encrypted key');
          key = Buffer.from(encoded, 'base64');
          if (key.length !== 32) throw new Error('Invalid encrypted key');
        } finally {
          await file.close();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        key = crypto.randomBytes(32);
        const encrypted = storage.encryptString(key.toString('base64'));
        // Never overwrite the only recoverable key. Partial writes fail closed.
        const file = await fs.promises.open(this.keyPath, 'wx', 0o600);
        try {
          await file.writeFile(encrypted);
          await file.sync();
        } finally {
          await file.close();
        }
      }
      // The service may commit a verifier immediately after bootstrap. Verify
      // the on-disk ciphertext and persist its directory entry first so a crash
      // cannot leave committed file data with a missing/unrecoverable master.
      let persisted: Buffer | undefined;
      const persistedFile = await fs.promises.open(this.keyPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const info = await persistedFile.stat();
        if (!info.isFile() || info.size > 16_384) throw new Error('Invalid encrypted key');
        const encoded = storage.decryptString(await persistedFile.readFile());
        if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) throw new Error('Invalid encrypted key');
        persisted = Buffer.from(encoded, 'base64');
        if (persisted.length !== 32 || !crypto.timingSafeEqual(key, persisted)) throw new Error('Encrypted key verification failed');
        await persistedFile.sync();
      } finally {
        persisted?.fill(0);
        await persistedFile.close();
      }
      const directory = await fs.promises.open(path.dirname(this.keyPath), fs.constants.O_RDONLY);
      try { await directory.sync() } finally { await directory.close() }
      await this.bootstrap(key);
    } catch {
      // Neither Electron nor HTTP errors may leak decrypted material to logs.
      throw new Error('Files could not unlock using the OS keychain');
    } finally {
      key?.fill(0);
    }
  }
}

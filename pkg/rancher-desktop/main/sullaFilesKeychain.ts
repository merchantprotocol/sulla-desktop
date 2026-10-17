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
    private readonly legacyKeys: { sourcePath: string; archivePath: string }[] = [],
  ) {}

  unlock(): Promise<void> {
    this.opening ??= this.open().finally(() => { this.opening = undefined });
    return this.opening;
  }

  async settled(): Promise<void> {
    await this.opening?.catch(() => undefined);
  }

  /** Preserve old key material under OS protection before retiring plaintext. */
  private async archiveLegacyKey(storage: FilesSafeStorage, legacy: { sourcePath: string; archivePath: string }): Promise<void> {
    let source;
    try {
      source = await fs.promises.open(legacy.sourcePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    let original: Buffer | undefined;
    let verified: Buffer | undefined;
    let current: Buffer | undefined;
    try {
      const initial = await source.stat();
      if (!initial.isFile() || initial.size !== 32) throw new Error('Invalid legacy key');
      original = Buffer.alloc(32);
      const originalRead = await source.read(original, 0, 32, 0);
      if (originalRead.bytesRead !== 32) throw new Error('Invalid legacy key');
      await fs.promises.mkdir(path.dirname(legacy.archivePath), { recursive: true, mode: 0o700 });
      try {
        const encrypted = storage.encryptString(original.toString('base64'));
        const archive = await fs.promises.open(legacy.archivePath, 'wx', 0o600);
        try {
          await archive.writeFile(encrypted);
          await archive.sync();
        } finally {
          await archive.close();
        }
      } catch (error) {
        // An interrupted previous migration is recoverable only if the existing
        // archive decrypts to exactly the same key. Never overwrite a conflict.
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const archive = await fs.promises.open(legacy.archivePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const info = await archive.stat();
        if (!info.isFile() || info.size > 16_384) throw new Error('Invalid archived key');
        verified = Buffer.from(storage.decryptString(await archive.readFile()), 'base64');
        await archive.sync();
      } finally {
        await archive.close();
      }
      if (verified.length !== 32 || !crypto.timingSafeEqual(original, verified)) throw new Error('Legacy archive conflict');
      // Persist the directory entry as well as the archive contents before the
      // plaintext is unlinked. Unsupported durability primitives fail closed.
      const directory = await fs.promises.open(path.dirname(legacy.archivePath), fs.constants.O_RDONLY);
      try { await directory.sync() } finally { await directory.close() }
      const latest = await fs.promises.lstat(legacy.sourcePath);
      if (!latest.isFile() || latest.dev !== initial.dev || latest.ino !== initial.ino || latest.size !== initial.size || latest.mtimeMs !== initial.mtimeMs || latest.ctimeMs !== initial.ctimeMs) throw new Error('Legacy key changed during migration');
      current = Buffer.alloc(32);
      const read = await source.read(current, 0, 32, 0);
      if (read.bytesRead !== 32 || !crypto.timingSafeEqual(original, current)) throw new Error('Legacy key changed during migration');
      await fs.promises.unlink(legacy.sourcePath);
    } finally {
      original?.fill(0);
      verified?.fill(0);
      current?.fill(0);
      await source.close();
    }
  }

  private async open(): Promise<void> {
    let key: Buffer | undefined;
    try {
      const storage = await this.storage();
      if (!storage.isEncryptionAvailable() || storage.getSelectedStorageBackend?.() === 'basic_text') {
        throw new Error('Secure OS key storage is unavailable');
      }
      await fs.promises.mkdir(path.dirname(this.keyPath), { recursive: true, mode: 0o700 });
      for (const legacy of this.legacyKeys) await this.archiveLegacyKey(storage, legacy);
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
      await this.bootstrap(key);
    } catch {
      // Neither Electron nor HTTP errors may leak decrypted material to logs.
      throw new Error('Files could not unlock using the OS keychain');
    } finally {
      key?.fill(0);
    }
  }
}

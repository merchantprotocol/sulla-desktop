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
  private opening?:   Promise<void>;
  private archiving?: Promise<void>;

  constructor(
    private readonly keyPath: string,
    private readonly storage: () => Promise<FilesSafeStorage>,
    private readonly bootstrap: (key: Buffer) => Promise<void>,
    private readonly legacyKeys: { sourcePath: string; archivePath: string }[] = [],
    private readonly legacyImporter?: (master:Buffer, legacyMasters:Buffer[]) => Promise<void>,
  ) {}

  unlock(): Promise<void> {
    this.opening ??= this.open().finally(() => { this.opening = undefined });
    return this.opening;
  }

  async settled(): Promise<void> {
    await Promise.all([this.opening?.catch(() => undefined), this.archiving?.catch(() => undefined)]);
  }

  /** Decrypt archived masters only inside Electron's safeStorage process. */
  async importLegacy():Promise<void> {
    if (!this.legacyImporter) throw new Error('Files legacy importer is unavailable');
    const storage = await this.storage();
    if (!storage.isEncryptionAvailable() || storage.getSelectedStorageBackend?.() === 'basic_text') throw new Error('Secure OS key storage is unavailable');
    const master = await this.loadMaster(storage); const legacyMasters:Buffer[] = [];
    try {
      for (const legacy of this.legacyKeys) {
        let file;
        try { file = await fs.promises.open(legacy.archivePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW) } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        try {
          const info = await file.stat(); if (!info.isFile() || info.size > 16_384) throw new Error('Invalid archived key');
          const value = Buffer.from(storage.decryptString(await file.readFile()), 'base64');
          if (value.length !== 32) { value.fill(0); throw new Error('Invalid archived key') }
          legacyMasters.push(value);
        } finally { await file.close() }
      }
      if (!legacyMasters.length) throw new Error('No archived legacy Files master is available');
      await this.legacyImporter(master, legacyMasters);
    } finally { master.fill(0); for (const key of legacyMasters) key.fill(0); }
  }

  /** Run only after the service confirms legacy classification has completed. */
  archiveLegacyKeys():Promise<void> {
    if (this.legacyKeys.length === 0) return Promise.resolve();
    this.archiving ??= this.archiveAllLegacyKeys().finally(() => { this.archiving = undefined });
    return this.archiving;
  }

  private async archiveAllLegacyKeys():Promise<void> {
    try {
      const storage = await this.storage();
      if (!storage.isEncryptionAvailable() || storage.getSelectedStorageBackend?.() === 'basic_text') throw new Error('Secure OS key storage is unavailable');
      for (const legacy of this.legacyKeys) await this.archiveLegacyKey(storage, legacy);
    } catch {
      throw new Error('Files could not secure legacy key material using the OS keychain');
    }
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
        // Resume only when the durable archive decrypts to this exact source.
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
      try {
        const storage = await this.storage();
        if (!storage.isEncryptionAvailable() || storage.getSelectedStorageBackend?.() === 'basic_text') {
          throw new Error('Secure OS key storage is unavailable');
        }
        key = await this.loadMaster(storage);
      } catch {
        throw new Error('Files could not unlock using the OS keychain');
      }
      try {
        await this.bootstrap(key);
      } catch {
        // Bootstrap responses are sanitized by the Files service. Keep them
        // distinct from safeStorage failures without exposing decrypted material.
        throw new Error('Files service could not finish secure startup');
      }
    } finally {
      key?.fill(0);
    }
  }

  private async loadMaster(storage:FilesSafeStorage):Promise<Buffer> {
    await fs.promises.mkdir(path.dirname(this.keyPath), { recursive: true, mode: 0o700 });
    let key:Buffer;
    try {
      const file = await fs.promises.open(this.keyPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const info = await file.stat(); if (!info.isFile() || info.size > 16_384) throw new Error('Invalid encrypted key');
        const encoded = storage.decryptString(await file.readFile());
        if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) throw new Error('Invalid encrypted key');
        key = Buffer.from(encoded, 'base64'); if (key.length !== 32) throw new Error('Invalid encrypted key');
      } finally { await file.close() }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      key = crypto.randomBytes(32); const encrypted = storage.encryptString(key.toString('base64'));
      const file = await fs.promises.open(this.keyPath, 'wx', 0o600);
      try { await file.writeFile(encrypted); await file.sync() } finally { await file.close() }
    }
    let persisted:Buffer | undefined;
    const file = await fs.promises.open(this.keyPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const info = await file.stat(); if (!info.isFile() || info.size > 16_384) throw new Error('Invalid encrypted key');
      const encoded = storage.decryptString(await file.readFile()); if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) throw new Error('Invalid encrypted key');
      persisted = Buffer.from(encoded, 'base64');
      if (persisted.length !== 32 || !crypto.timingSafeEqual(key, persisted)) throw new Error('Encrypted key verification failed');
      await file.sync();
    } finally { persisted?.fill(0); await file.close() }
    const directory = await fs.promises.open(path.dirname(this.keyPath), fs.constants.O_RDONLY);
    try { await directory.sync() } finally { await directory.close() }
    return key;
  }
}

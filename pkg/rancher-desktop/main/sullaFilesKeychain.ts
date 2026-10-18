import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface FilesSafeStorage {
  isEncryptionAvailable():boolean;
  getSelectedStorageBackend?():string;
  encryptString(value:string):Buffer;
  decryptString(value:Buffer):string;
}
export interface LegacyFilesKeyLocation { sourcePath:string; archivePath:string }

/** Key-file mechanics used only by the isolated Files bootstrap process. */
export class SullaFilesKeychain {
  constructor(
    private readonly keyPath:string,
    private readonly storage:()=>Promise<FilesSafeStorage>,
    _retiredBootstrap?:unknown,
    private readonly legacyKeys:LegacyFilesKeyLocation[] = [],
    _retiredLegacyImporter?:unknown,
  ) {}

  async hasMaster():Promise<boolean> {
    try { const file = await this.safeFile(this.keyPath); await file.close(); return true } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  async openExistingMaster():Promise<Buffer> {
    const storage = await this.secureStorage(); const file = await this.safeFile(this.keyPath);
    try { return this.decodeKey(storage.decryptString(await file.readFile()), 'Files master') } finally { await file.close() }
  }

  generateMaster():Buffer { return crypto.randomBytes(32) }

  /** Persist after authenticated service disposition, before any sealed handoff. */
  async persistMaster(master:Buffer):Promise<void> {
    if (master.length !== 32) throw new Error('Invalid Files master');
    const storage = await this.secureStorage();
    await fs.promises.mkdir(path.dirname(this.keyPath), { recursive: true, mode: 0o700 });
    const encrypted = storage.encryptString(master.toString('base64url'));
    const temporary = `${ this.keyPath }.candidate-${ process.pid }-${ crypto.randomUUID() }`;
    try {
      const candidate = await fs.promises.open(temporary, 'wx', 0o600);
      try {
        await candidate.writeFile(encrypted); await candidate.sync();
      } finally { await candidate.close() }
      try { await fs.promises.link(temporary, this.keyPath) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = await this.openExistingMaster();
        try { if (!crypto.timingSafeEqual(existing, master)) throw new Error('Files master appeared during bootstrap') } finally { existing.fill(0) }
      }
      const directory = await fs.promises.open(path.dirname(this.keyPath), fs.constants.O_RDONLY);
      try {
        await directory.sync();
        await fs.promises.unlink(temporary);
        await directory.sync();
      } finally { await directory.close() }
    } finally {
      encrypted.fill(0);
      await fs.promises.unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error });
    }
  }

  /** Files, not this helper, decides whether any bounded candidate is used. */
  async legacyCandidates():Promise<Buffer[]> {
    const storage = await this.secureStorage(); const candidates:Buffer[] = [];
    try {
      for (const location of this.legacyKeys) {
        const archived = await this.readOptionalKey(location.archivePath, value => storage.decryptString(value));
        if (archived) candidates.push(archived);
        const source = await this.readOptionalKey(location.sourcePath, value => value.toString('base64url'));
        if (source) candidates.push(source);
      }
      const unique:Buffer[] = [];
      for (const candidate of candidates) {
        if (unique.some(value => crypto.timingSafeEqual(value, candidate))) candidate.fill(0); else unique.push(candidate);
      }
      return unique;
    } catch (error) { for (const candidate of candidates) candidate.fill(0); throw error }
  }

  /** Archive and remove raw sources only after Files reports a completed import. */
  async retireConsumedLegacySources():Promise<void> {
    const storage = await this.secureStorage();
    for (const location of this.legacyKeys) {
      let source:fs.promises.FileHandle;
      try { source = await this.safeFile(location.sourcePath) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      let raw:Buffer | undefined; let verified:Buffer | undefined; let currentBytes:Buffer | undefined;
      try {
        const initial = await source.stat(); raw = await source.readFile();
        if (raw.length !== 32) throw new Error('Invalid legacy Files master');
        await fs.promises.mkdir(path.dirname(location.archivePath), { recursive: true, mode: 0o700 });
        const encrypted = storage.encryptString(raw.toString('base64url'));
        const candidatePath = `${ location.archivePath }.candidate-${ process.pid }-${ crypto.randomUUID() }`;
        try {
          try {
            const candidate = await fs.promises.open(candidatePath, 'wx', 0o600);
            try { await candidate.writeFile(encrypted); await candidate.sync() } finally { await candidate.close() }
            try { await fs.promises.link(candidatePath, location.archivePath) } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            }
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
        } finally {
          encrypted.fill(0);
          await fs.promises.unlink(candidatePath).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error });
        }
        const archive = await this.safeFile(location.archivePath);
        try { verified = this.decodeKey(storage.decryptString(await archive.readFile()), 'archived legacy Files master') } finally { await archive.close() }
        if (!crypto.timingSafeEqual(raw, verified)) throw new Error('Legacy Files archive conflict');
        const archiveDirectory = await fs.promises.open(path.dirname(location.archivePath), fs.constants.O_RDONLY);
        try { await archiveDirectory.sync() } finally { await archiveDirectory.close() }
        const current = await fs.promises.lstat(location.sourcePath);
        if (!current.isFile() || current.isSymbolicLink() || current.dev !== initial.dev || current.ino !== initial.ino || current.size !== 32 ||
            current.mtimeMs !== initial.mtimeMs || current.ctimeMs !== initial.ctimeMs) {
          throw new Error('Legacy Files master changed during archival');
        }
        currentBytes = Buffer.alloc(32);
        const reread = await source.read(currentBytes, 0, currentBytes.length, 0);
        if (reread.bytesRead !== 32 || !crypto.timingSafeEqual(raw, currentBytes)) throw new Error('Legacy Files master changed during archival');
        await fs.promises.unlink(location.sourcePath);
        const sourceDirectory = await fs.promises.open(path.dirname(location.sourcePath), fs.constants.O_RDONLY);
        try { await sourceDirectory.sync() } finally { await sourceDirectory.close() }
      } finally { raw?.fill(0); verified?.fill(0); currentBytes?.fill(0); await source.close() }
    }
  }

  // Retired normal-process API: source-compatible, permanently fail closed.
  unlock():Promise<void> { return Promise.reject(new Error('Files keys require the isolated bootstrap helper')) }
  settled():Promise<void> { return Promise.resolve() }
  importLegacy():Promise<void> { return Promise.reject(new Error('Files lifecycle owns legacy import')) }
  archiveLegacyKeys():Promise<void> { return Promise.reject(new Error('Files lifecycle owns legacy import')) }

  private async secureStorage():Promise<FilesSafeStorage> {
    const storage = await this.storage();
    if (!storage.isEncryptionAvailable() || storage.getSelectedStorageBackend?.() === 'basic_text') throw new Error('Secure OS key storage is unavailable');
    return storage;
  }
  private async safeFile(filePath:string):Promise<fs.promises.FileHandle> {
    const file = await fs.promises.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile() || info.size <= 0 || info.size > 16_384) { await file.close(); throw new Error('Invalid Files key file') }
    return file;
  }
  private decodeKey(encoded:string, label:string):Buffer {
    // Accept the canonical historical padded base64 blob and new base64url encoding.
    const key = /^[A-Za-z0-9+/]{43}=$/.test(encoded) ? Buffer.from(encoded, 'base64') : Buffer.from(encoded, 'base64url');
    if ((!/^[A-Za-z0-9_-]{43}$/.test(encoded) && !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) || key.length !== 32) {
      key.fill(0); throw new Error(`Invalid ${ label }`);
    }
    return key;
  }
  private async readOptionalKey(filePath:string, decode:(value:Buffer)=>string):Promise<Buffer | undefined> {
    let file:fs.promises.FileHandle;
    try { file = await this.safeFile(filePath) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    try { return this.decodeKey(decode(await file.readFile()), 'legacy Files master') } finally { await file.close() }
  }
}

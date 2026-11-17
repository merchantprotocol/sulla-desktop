import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import paths from '@pkg/utils/paths';
import type { OrgFilesVaultKeyStore } from '../orgFiles/OrgFilesRecipientKeyStore';

export interface OrgFilesProtectedStorage {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

interface EncryptedOrgFilesKey { v: 1; nonce: string; ct: string; tag: string; wrappedDataKey: string }

/** OS-protected envelope encryption for this device's private org Files recipient JWK. */
export class FileOrgFilesKeyStore implements OrgFilesVaultKeyStore {
  constructor(
    private readonly storage: () => OrgFilesProtectedStorage,
    private readonly directory: () => string = () => paths.sullaConfig,
    private readonly filesystem: typeof fs = fs,
  ) {}

  async read(itemKey: string): Promise<JsonWebKey | null> {
    const identity = this.identity(itemKey);
    const encryptedPath = this.filePath(identity.digest, '.enc');
    try {
      const encrypted = await this.filesystem.promises.readFile(encryptedPath, 'utf8');
      return this.decrypt(JSON.parse(encrypted) as EncryptedOrgFilesKey, identity.userId, identity.orgId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const legacyPath = this.filePath(identity.digest, '.json');
    let legacy: Buffer;
    try { legacy = await this.filesystem.promises.readFile(legacyPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    const stored = JSON.parse(legacy.toString('utf8')) as { v?: number; privateJwk?: JsonWebKey };
    if (stored?.v !== 1 || !this.isPrivateP256Jwk(stored.privateJwk)) throw new Error('Legacy Org Files recipient key is invalid');
    await this.write(itemKey, stored.privateJwk);
    await this.filesystem.promises.writeFile(legacyPath, Buffer.alloc(legacy.byteLength));
    await this.filesystem.promises.unlink(legacyPath);
    legacy.fill(0);
    return stored.privateJwk;
  }

  async write(itemKey: string, value: JsonWebKey): Promise<void> {
    if (!this.isPrivateP256Jwk(value)) throw new Error('Org Files recipient key must be a private P-256 JWK');
    const { userId, orgId, digest } = this.identity(itemKey);
    const protectedStorage = this.requireStorage();
    const dataKey = randomBytes(32);
    try {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', dataKey, nonce);
      cipher.setAAD(Buffer.from(`sulla-org-files-recipient-key|v1|${userId}|${orgId}`));
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
      const serialized: EncryptedOrgFilesKey = {
        v: 1, nonce: nonce.toString('base64'), ct: ciphertext.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        wrappedDataKey: protectedStorage.encryptString(dataKey.toString('base64')).toString('base64'),
      };
      await this.writeAtomic(this.filePath(digest, '.enc'), JSON.stringify(serialized));
    } finally { dataKey.fill(0); }
  }

  private decrypt(envelope: EncryptedOrgFilesKey, userId: string, orgId: string): JsonWebKey {
    if (envelope?.v !== 1 || ![envelope.nonce, envelope.ct, envelope.tag, envelope.wrappedDataKey].every(value => typeof value === 'string')) {
      throw new Error('Org Files recipient key ciphertext is invalid');
    }
    const storage = this.requireStorage();
    const dataKey = Buffer.from(storage.decryptString(Buffer.from(envelope.wrappedDataKey, 'base64')), 'base64');
    try {
      if (dataKey.byteLength !== 32) throw new Error('Org Files recipient data key is invalid');
      const decipher = createDecipheriv('aes-256-gcm', dataKey, Buffer.from(envelope.nonce, 'base64'));
      decipher.setAAD(Buffer.from(`sulla-org-files-recipient-key|v1|${userId}|${orgId}`));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ct, 'base64')), decipher.final()]).toString('utf8');
      const stored = JSON.parse(plaintext) as { v?: number; privateJwk?: JsonWebKey };
      if (stored?.v !== 1 || !this.isPrivateP256Jwk(stored.privateJwk)) throw new Error('Org Files recipient key is invalid');
      return stored.privateJwk;
    } finally { dataKey.fill(0); }
  }

  private async writeAtomic(target: string, value: string): Promise<void> {
    const directory = path.dirname(target);
    await this.filesystem.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    await this.filesystem.promises.chmod(directory, 0o700);
    const temporary = `${target}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    const file = await this.filesystem.promises.open(temporary, 'wx', 0o600);
    try { await file.writeFile(value); await file.sync(); }
    finally { await file.close(); }
    try { await this.filesystem.promises.rename(temporary, target); await this.filesystem.promises.chmod(target, 0o600); }
    finally { await this.filesystem.promises.unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
  }

  private requireStorage(): OrgFilesProtectedStorage {
    const storage = this.storage();
    if (!storage.isEncryptionAvailable()) throw new Error('OS-protected storage is required for Org Files recipient keys');
    return storage;
  }

  private identity(itemKey: string): { userId: string; orgId: string; digest: string } {
    const match = /^org-files-recipient:([^:]+):([^:]+)$/.exec(itemKey);
    if (!match) throw new Error('Org Files key reference is invalid');
    const [, userId, orgId] = match;
    return { userId, orgId, digest: createHash('sha256').update(`${userId}|${orgId}`).digest('hex') };
  }

  private filePath(digest: string, suffix: '.enc' | '.json'): string { return path.join(this.directory(), 'org-files-keys', `${digest}${suffix}`); }

  private isPrivateP256Jwk(value: unknown): value is JsonWebKey {
    if (!value || typeof value !== 'object') return false;
    const jwk = value as JsonWebKey;
    return jwk.kty === 'EC' && jwk.crv === 'P-256' && typeof jwk.x === 'string' && typeof jwk.y === 'string' &&
      typeof jwk.d === 'string' && jwk.x.length > 0 && jwk.y.length > 0 && jwk.d.length > 0;
  }
}

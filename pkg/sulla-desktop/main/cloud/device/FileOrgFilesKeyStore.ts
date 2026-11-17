import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import paths from '@pkg/utils/paths';
import type { OrgFilesVaultKeyStore } from '../orgFiles/OrgFilesRecipientKeyStore';
import { PrivateFile } from './PrivateFile';

interface OrgFilesKeyFileV1 { v: 1; privateJwk: JsonWebKey }

/** Stores each device's recipient private JWK in ~/.sulla/org-files-keys, owner-only and atomically created. */
export class FileOrgFilesKeyStore implements OrgFilesVaultKeyStore {
  constructor(
    private readonly directory: () => string = () => paths.sullaConfig,
    private readonly filesystem: typeof fs = fs,
  ) {}

  async read(itemKey: string): Promise<JsonWebKey | null> {
    const file = this.fileFor(this.digest(itemKey));
    const text = file.read();
    if (text === null) return null;
    const stored = JSON.parse(text) as OrgFilesKeyFileV1;
    if (stored?.v !== 1 || !this.isPrivateP256Jwk(stored.privateJwk)) {
      throw new Error(`[orgFilesKey] ${file.path} is not a valid v1 recipient key file`);
    }
    return stored.privateJwk;
  }

  async write(itemKey: string, value: JsonWebKey): Promise<void> {
    if (!this.isPrivateP256Jwk(value)) throw new Error('Org Files recipient key must be a private P-256 JWK');
    this.fileFor(this.digest(itemKey)).createExclusive(JSON.stringify({ v: 1, privateJwk: value }));
  }

  private digest(itemKey: string): string {
    const match = /^org-files-recipient:([^:]+):([^:]+)$/.exec(itemKey);
    if (!match) throw new Error('Org Files key reference is invalid');
    return createHash('sha256').update(`${match[1]}|${match[2]}`).digest('hex');
  }

  private fileFor(digest: string): PrivateFile {
    return new PrivateFile(() => path.join(this.directory(), 'org-files-keys'), `${digest}.json`, this.filesystem);
  }

  private isPrivateP256Jwk(value: unknown): value is JsonWebKey {
    if (!value || typeof value !== 'object') return false;
    const jwk = value as JsonWebKey;
    return jwk.kty === 'EC' && jwk.crv === 'P-256' && typeof jwk.x === 'string' && typeof jwk.y === 'string' &&
      typeof jwk.d === 'string' && jwk.x.length > 0 && jwk.y.length > 0 && jwk.d.length > 0;
  }
}

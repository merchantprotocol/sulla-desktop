// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { createHash } from 'node:crypto';
import path from 'node:path';
import paths from '@pkg/utils/paths';
import type { OrgFilesVaultKeyStore } from '../orgFiles/OrgFilesRecipientKeyStore';
import { PrivateFile } from './PrivateFile';

interface OrgFilesKeyFileV1 { v: 1; privateJwk: JsonWebKey }

/** Per-device recipient private keys, owner-only and atomically stored under ~/.sulla/org-files-keys/. */
export class FileOrgFilesKeyStore implements OrgFilesVaultKeyStore {
  constructor(private readonly directory: () => string = () => paths.sullaConfig) {}

  async read(itemKey: string): Promise<JsonWebKey | null> {
    const file = this.fileFor(itemKey);
    const text = file.read();
    if (text === null) return null;
    const stored = JSON.parse(text) as OrgFilesKeyFileV1;
    if (stored?.v !== 1 || !this.isPrivateP256Jwk(stored.privateJwk)) {
      throw new Error(`[orgFilesKey] ${file.path} is not a v1 P-256 recipient key file`);
    }
    return stored.privateJwk;
  }

  async write(itemKey: string, value: JsonWebKey): Promise<void> {
    if (!this.isPrivateP256Jwk(value)) throw new Error('Org Files recipient key must be a private P-256 JWK');
    this.fileFor(itemKey).createExclusive(JSON.stringify({ v: 1, privateJwk: value } satisfies OrgFilesKeyFileV1));
  }

  private fileFor(itemKey: string): PrivateFile {
    const match = /^org-files-recipient:([^:]+):([^:]+)$/.exec(itemKey);
    if (!match) throw new Error('Org Files Vault item reference is invalid');
    const digest = createHash('sha256').update(`${match[1]}|${match[2]}`).digest('hex');
    return new PrivateFile(() => path.join(this.directory(), 'org-files-keys'), `${digest}.json`);
  }

  private isPrivateP256Jwk(value: unknown): value is JsonWebKey {
    if (!value || typeof value !== 'object') return false;
    const jwk = value as JsonWebKey;
    return jwk.kty === 'EC' && jwk.crv === 'P-256' && typeof jwk.x === 'string' && typeof jwk.y === 'string' &&
      typeof jwk.d === 'string' && jwk.x.length > 0 && jwk.y.length > 0 && jwk.d.length > 0;
  }
}

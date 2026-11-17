import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { FileOrgFilesKeyStore } from '../../device/FileOrgFilesKeyStore';

describe('FileOrgFilesKeyStore', () => {
  const directories: string[] = [];
  const makeDirectory = () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'org-files-key-'));
    directories.push(directory);
    return directory;
  };
  const digestFor = (userId: string, orgId: string) => createHash('sha256').update(`${userId}|${orgId}`).digest('hex');
  afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

  it('stores the per-device JWK in an atomic owner-only file under its hashed identity', async () => {
    // risk: private-key custody — only the intended local user/org file may hold the private recipient key.
    const directory = makeDirectory();
    const store = new FileOrgFilesKeyStore(() => directory);
    const itemKey = 'org-files-recipient:user-1:org-1';
    const privateJwk: JsonWebKey = { kty: 'EC', crv: 'P-256', x: 'public-x', y: 'public-y', d: 'synthetic-private-key' };
    await store.write(itemKey, privateJwk);
    const filePath = path.join(directory, 'org-files-keys', `${digestFor('user-1', 'org-1')}.json`);
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({ v: 1, privateJwk });
    expect(await store.read(itemKey)).toEqual(privateJwk);
    expect(fs.statSync(path.dirname(filePath)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it('does not overwrite an existing key when a concurrent writer loses create-if-absent', async () => {
    // risk: key continuity — a race must not replace the public key already registered in Cloud.
    const directory = makeDirectory();
    const store = new FileOrgFilesKeyStore(() => directory);
    const itemKey = 'org-files-recipient:user-1:org-1';
    const first: JsonWebKey = { kty: 'EC', crv: 'P-256', x: 'x1', y: 'y1', d: 'private1' };
    const second: JsonWebKey = { kty: 'EC', crv: 'P-256', x: 'x2', y: 'y2', d: 'private2' };
    await store.write(itemKey, first);
    await store.write(itemKey, second);
    expect(await store.read(itemKey)).toEqual(first);
  });

  it('rejects malformed references and non-private keys', async () => {
    // risk: identity isolation — only complete user/org identities and valid private P-256 keys are accepted.
    const store = new FileOrgFilesKeyStore(() => makeDirectory());
    await expect(store.read('bad-reference')).rejects.toThrow('key reference is invalid');
    await expect(store.write('org-files-recipient:user-1:org-1', { kty: 'EC', crv: 'P-256' })).rejects.toThrow('private P-256 JWK');
  });
});

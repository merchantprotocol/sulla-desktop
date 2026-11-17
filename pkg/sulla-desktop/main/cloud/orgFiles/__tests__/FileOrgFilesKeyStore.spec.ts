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
  afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

  it('stores each device recipient private key in a hashed, owner-only file and reads it back', async () => {
    // risk: private-key custody — recipient private material must remain in the restricted per-device key store.
    const directory = makeDirectory();
    const store = new FileOrgFilesKeyStore(() => directory);
    const itemKey = 'org-files-recipient:user-1:org-1';
    const privateJwk: JsonWebKey = { kty: 'EC', crv: 'P-256', x: 'public-x', y: 'public-y', d: 'synthetic-private-key' };
    await store.write(itemKey, privateJwk);
    const filename = createHash('sha256').update('user-1|org-1').digest('hex') + '.json';
    const filePath = path.join(directory, 'org-files-keys', filename);
    expect(await store.read(itemKey)).toEqual(privateJwk);
    expect(fs.statSync(path.dirname(filePath)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
  });
});

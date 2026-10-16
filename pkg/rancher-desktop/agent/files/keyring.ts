import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { decryptWithKey, encryptWithKey, type EncryptedEnvelope } from '../../../../packages/vault-crypto/src/index';

export class FileKeyring {
  private master?: Uint8Array;
  constructor(private readonly masterKeyPath: string) {}

  private async masterKey(): Promise<Uint8Array> {
    if (this.master) return this.master;
    try {
      this.master = new Uint8Array(await readFile(this.masterKeyPath));
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
      await mkdir(dirname(this.masterKeyPath), { recursive: true, mode: 0o700 });
      this.master = randomBytes(32);
      await writeFile(this.masterKeyPath, this.master, { mode: 0o600, flag: 'wx' });
    }
    if (this.master.byteLength !== 32) throw new Error('Sulla Files master key must be 32 bytes');
    return this.master;
  }

  async create(collectionId: string): Promise<{ encryptedDataKey: EncryptedEnvelope; encryptedDedupKey: EncryptedEnvelope }> {
    const master = await this.masterKey();
    return {
      encryptedDataKey:  await encryptWithKey(randomBytes(32), master, `sulla:files:data-key:v1:${ collectionId }`),
      encryptedDedupKey: await encryptWithKey(randomBytes(32), master, `sulla:files:dedup-key:v1:${ collectionId }`),
    };
  }

  async unwrap(collectionId: string, data: EncryptedEnvelope, dedup: EncryptedEnvelope): Promise<{ dataKey: Uint8Array; dedupKey: Uint8Array }> {
    const master = await this.masterKey();
    return {
      dataKey:  await decryptWithKey(data, master, `sulla:files:data-key:v1:${ collectionId }`),
      dedupKey: await decryptWithKey(dedup, master, `sulla:files:dedup-key:v1:${ collectionId }`),
    };
  }
}

import { randomBytes } from 'node:crypto';

import { decrypt, encrypt, type Envelope } from '../crypto.js';
import type { FilesKeyring } from '../keyring.js';

function context(collectionId:string, keyVersion:number):string {
  return `sulla:files:cloud-root:v1:${ collectionId }:${ keyVersion }`;
}

/**
 * Local at-rest storage for the cloud sync root key R. R is wrapped with the
 * collection's random data key, which FilesKeyring itself keeps only under the
 * Files master. This envelope never leaves the VM; nothing here reaches Cloud.
 */
export class CloudRootKeyStore {
  constructor(private readonly keyring:Pick<FilesKeyring, 'keys'>) {}

  /** Caller owns the returned root and must zero it. */
  async create(collectionId:string, keyVersion:number):Promise<{ root:Buffer; wrapped:Envelope }> {
    const root = randomBytes(32);
    try {
      return { root, wrapped: await this.wrap(collectionId, keyVersion, root) };
    } catch (error) {
      root.fill(0);
      throw error;
    }
  }

  async wrap(collectionId:string, keyVersion:number, root:Uint8Array):Promise<Envelope> {
    const keys = await this.keyring.keys(collectionId);
    return encrypt(root, keys.data, context(collectionId, keyVersion));
  }

  /** Caller owns the returned root and must zero it. */
  async unwrap(collectionId:string, keyVersion:number, wrapped:Envelope):Promise<Buffer> {
    const keys = await this.keyring.keys(collectionId);
    const root = await decrypt(wrapped, keys.data, context(collectionId, keyVersion));
    if (root.length !== 32) {
      root.fill(0);
      throw new Error('Invalid cloud sync root key');
    }
    const copy = Buffer.from(root);
    root.fill(0);
    return copy;
  }
}

import { randomBytes } from 'node:crypto';
import { decrypt, encrypt, type Envelope } from '../crypto.js';
import type { FilesKeyring } from '../keyring.js';

const context=(collectionId:string,keyVersion:number)=>`sulla:files:cloud-root:v1:${collectionId}:${keyVersion}`;

/** R is transitively protected by the Files master: its wrapping key is the random
 * collection data key, which FilesKeyring persists only encrypted under that master. */
export class CloudRootKeyStore {
  constructor(private readonly keyring:FilesKeyring){}
  async create(collectionId:string,keyVersion:number){const root=randomBytes(32);try{return{root:Buffer.from(root),wrapped:await this.wrap(collectionId,keyVersion,root)}}finally{root.fill(0)}}
  async wrap(collectionId:string,keyVersion:number,root:Uint8Array):Promise<Envelope>{const keys=await this.keyring.keys(collectionId);return encrypt(root,keys.data,context(collectionId,keyVersion))}
  async unwrap(collectionId:string,keyVersion:number,wrapped:Envelope):Promise<Buffer>{const keys=await this.keyring.keys(collectionId);const root=await decrypt(wrapped,keys.data,context(collectionId,keyVersion));if(root.length!==32){root.fill(0);throw new Error('Invalid cloud sync root key')}return Buffer.from(root)}
}

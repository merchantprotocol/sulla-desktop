import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import type pg from 'pg';
import type { FilesCloudBroker } from '../cloudBroker.js';
import { chunkId, FLAG_DEFLATE_RAW, openChunk } from './envelope.js';
import type { CloudRootKeyStore } from './keyStore.js';

// Identical local copy of the P4-owned contract; merge will replace this import boundary.
export interface CloudChunkSource {
  verifiedCopy(collectionId:string,localChunkId:string):Promise<{cloudChunkId:string;cipherSha256:string;cipherBytes:number;verifiedAt:Date}|null>;
  reverify(collectionId:string,localChunkId:string):Promise<boolean>;
  fetchPlain(collectionId:string,localChunkId:string):Promise<Buffer>;
}

export class FilesCloudChunkSource implements CloudChunkSource {
  constructor(private db:pg.Pool,private broker:FilesCloudBroker,private roots:CloudRootKeyStore){}
  async verifiedCopy(collectionId:string,localChunkId:string){const row=(await this.db.query(`SELECT cloud_chunk_id,cipher_sha256,cipher_bytes,verified_at FROM files_cloud_chunk_map WHERE collection_id=$1 AND local_chunk_id=$2 AND verified_at IS NOT NULL`,[collectionId,localChunkId])).rows[0];return row?{cloudChunkId:row.cloud_chunk_id,cipherSha256:row.cipher_sha256,cipherBytes:Number(row.cipher_bytes),verifiedAt:new Date(row.verified_at)}:null}
  private async bytes(collectionId:string,localChunkId:string){const row=(await this.db.query(`SELECT m.cloud_chunk_id,m.cipher_sha256,m.cipher_bytes,s.key_version,s.wrapped_root FROM files_cloud_chunk_map m JOIN files_cloud_sync s USING(collection_id) WHERE m.collection_id=$1 AND m.local_chunk_id=$2`,[collectionId,localChunkId])).rows[0];if(!row)throw Object.assign(new Error('No cloud copy is available'),{code:'FILE_OFFLINE'});let response;try{response=await this.broker.execute(`/files-sync/v1/collections/${collectionId}/chunks/${row.cloud_chunk_id}`)}catch(error){throw Object.assign(new Error('Cloud copy is unavailable',{cause:error}),{code:'FILE_OFFLINE'})}if(response.status!==200)throw Object.assign(new Error('Cloud copy is unavailable'),{code:'FILE_OFFLINE'});const encoded=typeof response.body==='string'?response.body:(response.body as any)?.body;const wire=Buffer.from(encoded??'','base64');if(wire.length!==Number(row.cipher_bytes)||createHash('sha256').update(wire).digest('hex')!==row.cipher_sha256)throw new Error('Cloud chunk ciphertext verification failed');return{row,wire}}
  async reverify(collectionId:string,localChunkId:string){try{await this.bytes(collectionId,localChunkId);await this.db.query('UPDATE files_cloud_chunk_map SET verified_at=NOW() WHERE collection_id=$1 AND local_chunk_id=$2',[collectionId,localChunkId]);return true}catch{return false}}
  async fetchPlain(collectionId:string,localChunkId:string){const{row,wire}=await this.bytes(collectionId,localChunkId);const root=await this.roots.unwrap(collectionId,row.key_version,row.wrapped_root);try{const opened=await openChunk(root,collectionId,row.key_version,row.cloud_chunk_id,wire);const plain=opened.flags&FLAG_DEFLATE_RAW?inflateRawSync(opened.body,{maxOutputLength:4*1024*1024}):opened.body;if(await chunkId(root,collectionId,row.key_version,plain)!==row.cloud_chunk_id)throw new Error('Cloud chunk plaintext identity mismatch');return plain}finally{root.fill(0)}}
}

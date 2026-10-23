export interface CloudChunkSource {
  /** null when this local chunk has no verified cloud copy */
  verifiedCopy(collectionId:string, localChunkId:string):Promise<{ cloudChunkId:string; cipherSha256:string; cipherBytes:number; verifiedAt:Date } | null>;
  /** re-check the cloud object now (size + sha256); true only on exact match */
  reverify(collectionId:string, localChunkId:string):Promise<boolean>;
  /** fetch, open, inflate, verify cloud id; returns PLAINTEXT. throws Error with code 'FILE_OFFLINE' when unreachable */
  fetchPlain(collectionId:string, localChunkId:string):Promise<Buffer>;
}

export type CollectionKind = 'knowledge' | 'scratch';
export type CollectionRole = 'view' | 'use-by-agents' | 'edit' | 'manage';

export type { ToolExecutionContext } from '../tools/executionContext';

export interface StoredChunk {
  id:    string;
  bytes: Uint8Array;
}

export interface ChunkStore {
  has(collectionId: string, chunkId: string): Promise<boolean>;
  get(collectionId: string, chunkId: string): Promise<Uint8Array>;
  put(collectionId: string, chunk: StoredChunk): Promise<void>;
  delete(collectionId: string, chunkId: string): Promise<void>;
}

export interface S3Credentials {
  accessKeyId:     string;
  secretAccessKey: string;
  sessionToken?:   string;
}

export type S3CredentialsProvider = () => Promise<S3Credentials>;

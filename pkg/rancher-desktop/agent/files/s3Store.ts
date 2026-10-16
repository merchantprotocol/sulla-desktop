import { createHash, createHmac } from 'node:crypto';

import type { ChunkStore, S3CredentialsProvider, StoredChunk } from './types';

interface S3StoreConfig {
  endpoint:    string;
  bucket:      string;
  region?:     string;
  prefix?:     string;
  credentials: S3CredentialsProvider;
}

function hmac(key: Uint8Array | string, data: string): Buffer { return createHmac('sha256', key).update(data).digest() }
function sha(data: Uint8Array | string): string { return createHash('sha256').update(data).digest('hex') }

/** Small S3-compatible driver; credentials are requested per call from the vault broker. */
export class S3ChunkStore implements ChunkStore {
  constructor(private readonly config: S3StoreConfig) {}

  private key(collectionId: string, chunkId: string): string {
    return [this.config.prefix?.replace(/^\/+|\/+$/g, ''), collectionId, chunkId.slice(0, 2), chunkId].filter(Boolean).join('/');
  }

  private async request(method: string, collectionId: string, chunkId: string, body = new Uint8Array()): Promise<Response> {
    const credentials = await this.config.credentials();
    const base = new URL(this.config.endpoint);
    const objectPath = `/${ encodeURIComponent(this.config.bucket) }/${ this.key(collectionId, chunkId).split('/').map(encodeURIComponent).join('/') }`;
    const url = new URL(objectPath, base);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const date = amzDate.slice(0, 8);
    const region = this.config.region ?? 'auto';
    const payloadHash = sha(body);
    const headers: Record<string, string> = { host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
    if (credentials.sessionToken) headers['x-amz-security-token'] = credentials.sessionToken;
    const signedHeaders = Object.keys(headers).sort().join(';');
    const canonicalHeaders = Object.keys(headers).sort().map(key => `${ key }:${ headers[key] }\n`).join('');
    const canonical = [method, objectPath, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const scope = `${ date }/${ region }/s3/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${ amzDate }\n${ scope }\n${ sha(canonical) }`;
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${ credentials.secretAccessKey }`, date), region), 's3'), 'aws4_request');
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${ credentials.accessKeyId }/${ scope }, SignedHeaders=${ signedHeaders }, Signature=${ hmac(signingKey, stringToSign).toString('hex') }`;
    return fetch(url, { method, headers, body: method === 'PUT' ? body : undefined });
  }

  async has(collectionId: string, chunkId: string): Promise<boolean> {
    const response = await this.request('HEAD', collectionId, chunkId);
    if (response.status === 404) return false;
    if (!response.ok) throw new Error(`S3 HEAD failed (${ response.status })`);
    return true;
  }

  async get(collectionId: string, chunkId: string): Promise<Uint8Array> {
    const response = await this.request('GET', collectionId, chunkId);
    if (!response.ok) throw new Error(`S3 GET failed (${ response.status })`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async put(collectionId: string, chunk: StoredChunk): Promise<void> {
    if (await this.has(collectionId, chunk.id)) return;
    const response = await this.request('PUT', collectionId, chunk.id, chunk.bytes);
    if (!response.ok) throw new Error(`S3 PUT failed (${ response.status })`);
  }

  async delete(collectionId: string, chunkId: string): Promise<void> {
    const response = await this.request('DELETE', collectionId, chunkId);
    if (!response.ok && response.status !== 404) throw new Error(`S3 DELETE failed (${ response.status })`);
  }
}

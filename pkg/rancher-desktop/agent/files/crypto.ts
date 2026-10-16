import { createHmac } from 'node:crypto';
import * as zlib from 'node:zlib';

import { decryptWithKey, encryptWithKey, type EncryptedEnvelope } from '../../../../packages/vault-crypto/src/index';

export interface EncryptedChunk {
  envelope:   EncryptedEnvelope;
  storedSize: number;
}

export function chunkId(plaintext: Uint8Array, dedupKey: Uint8Array): string {
  return createHmac('sha256', dedupKey).update(plaintext).digest('hex');
}

export async function encryptChunk(plaintext: Uint8Array, dataKey: Uint8Array, id: string): Promise<EncryptedChunk> {
  const compressed = (zlib as any).zstdCompressSync(Buffer.from(plaintext), { level: 3 }) as Buffer;
  const envelope = await encryptWithKey(compressed, dataKey, `sulla:file-chunk:v1:${ id }`);
  return { envelope, storedSize: Buffer.byteLength(JSON.stringify(envelope)) };
}

export async function decryptChunk(payload: Uint8Array, dataKey: Uint8Array, id: string): Promise<Uint8Array> {
  const envelope = JSON.parse(Buffer.from(payload).toString('utf8')) as EncryptedEnvelope;
  const compressed = await decryptWithKey(envelope, dataKey, `sulla:file-chunk:v1:${ id }`);
  return (zlib as any).zstdDecompressSync(Buffer.from(compressed));
}

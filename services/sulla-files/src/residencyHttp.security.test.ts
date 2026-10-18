import assert from 'node:assert/strict';
import test from 'node:test';

import { HttpResidencyTransport } from './residencyHttp.js';

test('residency requests follow Vault adoption and reject sentinel or mismatched principals', async() => {
  let principal = 'desktop-user';
  const subjects:string[] = [];
  const transport = new HttpResidencyTransport({
    serverUrl: 'https://synthetic.invalid',
    principalId: () => principal,
    deviceId: 'synthetic-device',
    capabilitySigningKey: 'synthetic-signing-key-32-bytes-long',
    bundleFor: async() => { throw new Error('No bundle is needed for this check') },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async(_url, init) => {
    const token = new Headers(init?.headers).get('authorization')!.slice('Bearer '.length);
    subjects.push(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).sub);
    return new Response(new Uint8Array([1]));
  };
  const input = {
    versionId: 'synthetic-version', collectionId: 'synthetic-collection',
    chunk: { id: 'synthetic-chunk', size: 1, storedSize: 1 },
    signal: new AbortController().signal,
  };
  try {
    await assert.rejects(transport.downloadChunk(input), /adopted Vault principal/);
    assert.deepEqual(subjects, []);
    principal = 'vault-principal-one';
    for await (const _bytes of await transport.downloadChunk(input)) { /* Consume synthetic response. */ }
    principal = 'vault-principal-two';
    for await (const _bytes of await transport.downloadChunk(input)) { /* Consume synthetic response. */ }
    assert.deepEqual(subjects, ['vault-principal-one', 'vault-principal-two']);
    await assert.rejects(transport.verifyVersion({ keyContext: { principalId: 'vault-principal-one' } } as any, input.signal), /key context/);
    assert.equal(subjects.length, 2, 'mismatched key custody must fail before a request');
    principal = '';
    await assert.rejects(transport.downloadChunk(input), /adopted Vault principal/);
    assert.equal(subjects.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

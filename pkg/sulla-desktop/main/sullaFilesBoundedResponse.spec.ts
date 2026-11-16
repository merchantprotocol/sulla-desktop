import assert from 'node:assert/strict';
import test from 'node:test';

import { BoundedFilesResponseReader } from './sullaFilesBoundedResponse.ts';

const reader = new BoundedFilesResponseReader();

test('bounded reader returns the complete response when it fits its byte limit', async () => {
  // risk: data integrity — native file publication must receive the exact body.
  const response = new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-length': '3' } });
  assert.deepEqual(await reader.read(response, 3), Buffer.from([1, 2, 3]));
});

test('bounded reader rejects a streamed body that exceeds the configured limit', async () => {
  // risk: resource exhaustion — an oversized Files response must not be buffered by Desktop.
  const response = new Response(new Uint8Array([1, 2, 3]));
  await assert.rejects(reader.read(response, 2), /exceeds the native source size bound/);
});

test('bounded reader rejects a response whose declared size differs from its body', async () => {
  // risk: data integrity — truncated or misreported content must not be published as complete.
  const response = new Response(new Uint8Array([1, 2]), { headers: { 'content-length': '3' } });
  await assert.rejects(reader.read(response, 3), /length changed during native publication/);
});

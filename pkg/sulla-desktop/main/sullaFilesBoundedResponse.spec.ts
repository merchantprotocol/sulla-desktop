import { describe, expect, it } from 'vitest';

import { BoundedFilesResponseReader } from './sullaFilesBoundedResponse.ts';

const reader = new BoundedFilesResponseReader();

describe('bounded Files response reader', () => {
it('returns the complete response when it fits its byte limit', async () => {
  // risk: data integrity — native file publication must receive the exact body.
  const response = new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-length': '3' } });
  expect(await reader.read(response, 3)).toEqual(Buffer.from([1, 2, 3]));
});

it('rejects a streamed body that exceeds the configured limit', async () => {
  // risk: resource exhaustion — an oversized Files response must not be buffered by Desktop.
  const response = new Response(new Uint8Array([1, 2, 3]));
  await expect(reader.read(response, 2)).rejects.toThrow(/exceeds the native source size bound/);
});

it('rejects a response whose declared size differs from its body', async () => {
  // risk: data integrity — truncated or misreported content must not be published as complete.
  const response = new Response(new Uint8Array([1, 2]), { headers: { 'content-length': '3' } });
  await expect(reader.read(response, 3)).rejects.toThrow(/length changed during native publication/);
});
});

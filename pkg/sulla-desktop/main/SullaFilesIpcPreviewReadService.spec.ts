// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';

import { FilesApiError } from './sullaFilesClient';
import { SullaFilesIpcPreviewReadService, SullaFilesPreviewContentClassifier, SullaFilesPreviewBoundedBodyReader, type SullaFilesPreviewReadCaps } from './SullaFilesIpcPreviewReadService';

const TEST_CAPS:SullaFilesPreviewReadCaps = { html:4, markdown:4, code:4, csv:4, image:4, pdf:4 };

function fileMetadata(overrides:Record<string, unknown> = {}) {
  const row = {
    id:'file-1', path:'notes.md', mime:'text/markdown', size:3, collection_id:'collection-1', current_version_id:'version-1', deleted_at:null,
    ...overrides,
  };
  const version = Object.prototype.hasOwnProperty.call(overrides, 'version') ? overrides.version : { id:row.current_version_id, size:row.size };
  return { ...row, version };
}

function api(options:{metadata?:unknown; json?:ReturnType<typeof vi.fn>; stream?:ReturnType<typeof vi.fn>; principal?:ReturnType<typeof vi.fn>} = {}) {
  const json = options.json ?? vi.fn(async() => options.metadata ?? fileMetadata());
  const stream = options.stream ?? vi.fn(async() => new Response(new TextEncoder().encode('hey')));
  const currentPrincipalId = options.principal ?? vi.fn(async() => 'human-a');
  return { client:{ json, stream, currentPrincipalId } };
}

function service(client:ReturnType<typeof api>) {
  return new SullaFilesIpcPreviewReadService(client as never, new SullaFilesPreviewContentClassifier(TEST_CAPS), new SullaFilesPreviewBoundedBodyReader());
}

describe('SullaFilesIpcPreviewReadService', () => {
  // risk: authorization — metadata and body must use current Desktop Files authority, never an agent or renderer-selected account.
  it('loads fresh metadata and the pinned current version through the main Files client on each read', async() => {
    const versions = ['version-1', 'version-2'];
    const client = api({
      json:vi.fn(async() => fileMetadata({ current_version_id:versions.shift() })),
      stream:vi.fn(async(endpoint:string) => new Response(endpoint.includes('version-1') ? 'one' : 'two')),
    });
    const reader = service(client);

    const first = await reader.read('file-1');
    const second = await reader.read('file-1');

    expect(first).toMatchObject({ state:'ready', kind:'markdown', content:'one', truncated:false });
    expect(second).toMatchObject({ state:'ready', kind:'markdown', content:'two', truncated:false });
    expect(client.client.json).toHaveBeenCalledTimes(2);
    expect(client.client.json.mock.calls[0]).toEqual(['/v1/files/file-1', {}]);
    expect(client.client.stream.mock.calls.map(call => call[0])).toEqual([
      '/v1/files/file-1/preview?versionId=version-1',
      '/v1/files/file-1/preview?versionId=version-2',
    ]);
    expect(client.client.stream.mock.calls[0]).toEqual(['/v1/files/file-1/preview?versionId=version-1', { method:'GET' }, undefined]);
    expect(first).not.toHaveProperty('url');
  });

  // risk: data accuracy — range and output size must use the authorized version's size, not the file's hidden draft size.
  it('uses the authorized current version metadata for the byte cap', async() => {
    const client = api({ metadata:fileMetadata({ size:80, version:{ id:'version-1', size:3 } }) });

    await expect(service(client).read('file-1')).resolves.toMatchObject({ state:'ready', document:{ size:3 }, content:'hey' });
    expect(client.client.stream).toHaveBeenCalledWith('/v1/files/file-1/preview?versionId=version-1', { method:'GET' }, undefined);
  });

  // risk: tenant isolation — forbidden and missing metadata must not trigger a body fetch or expose service error details.
  it.each([403, 404])('returns a neutral unavailable result for metadata status %s without fetching content', async(status) => {
    const client = api({ json:vi.fn(async() => { throw new FilesApiError('private server detail', status); }) });

    await expect(service(client).read('file-1')).resolves.toEqual({ state:'unavailable', reason:'not-available' });
    expect(client.client.stream).not.toHaveBeenCalled();
  });

  // risk: deleted file — a tombstone can expose metadata for retention but must never yield body bytes.
  it('returns a deleted state without requesting the preview body', async() => {
    const client = api({ metadata:fileMetadata({ deleted_at:'2026-01-01T00:00:00Z' }) });

    await expect(service(client).read('file-1')).resolves.toMatchObject({ state:'deleted', document:{ id:'file-1' } });
    expect(client.client.stream).not.toHaveBeenCalled();
  });

  // risk: deleted-after-open — if the file disappears between metadata and body requests, no stale or error body is returned.
  it('maps a deleted-between-requests body 404 to the same neutral unavailable state', async() => {
    const client = api({ stream:vi.fn(async() => new Response('private detail', { status:404 })) });

    await expect(service(client).read('file-1')).resolves.toEqual({ state:'unavailable', reason:'not-available' });
  });

  // risk: unbounded reads — incomplete metadata must stop before the preview endpoint is called.
  it('rejects metadata without an authorized version size before reading content', async() => {
    const client = api({ metadata:{ ...fileMetadata(), version:{ id:'version-1' } } });

    await expect(service(client).read('file-1')).resolves.toEqual({ state:'unavailable', reason:'invalid-metadata' });
    expect(client.client.stream).not.toHaveBeenCalled();
  });

  // risk: memory exhaustion — an upstream that ignores Range must be cancelled at the per-type cap.
  it('caps and cancels an oversized body even when the service ignores the requested range', async() => {
    const cancel = vi.fn();
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode('abcdefgh')); }
      },
      cancel,
    }, { highWaterMark:0 });
    const client = api({ metadata:fileMetadata({ size:8 }), stream:vi.fn(async() => new Response(body, { status:200, headers:{ 'content-length':'8' } })) });

    const result = await service(client).read('file-1');

    expect(result).toMatchObject({ state:'ready', kind:'markdown', content:'abcd', truncated:true });
    expect(client.client.stream).toHaveBeenCalledWith('/v1/files/file-1/preview?versionId=version-1', { method:'GET', headers:{ range:'bytes=0-3' } }, undefined);
    expect(cancel).toHaveBeenCalled();
  });

  // risk: range integrity — honor the Files server's documented 206 single-range response contract.
  it('accepts a matching zero-based Content-Range response and marks the prefix truncated', async() => {
    const client = api({
      metadata:fileMetadata({ size:8 }),
      stream:vi.fn(async() => new Response('abcd', { status:206, headers:{ 'content-range':'bytes 0-3/8', 'content-length':'4' } })),
    });

    await expect(service(client).read('file-1')).resolves.toMatchObject({ state:'ready', content:'abcd', truncated:true });
  });

  // risk: cross-account disclosure — a principal switch between metadata and body invalidates the load.
  it('does not fetch a body if the trusted Files principal changes after metadata', async() => {
    const principal = vi.fn().mockResolvedValueOnce('human-a').mockResolvedValueOnce('human-b');
    const client = api({ principal });

    await expect(service(client).read('file-1')).resolves.toEqual({ state:'unavailable', reason:'authority-changed' });
    expect(client.client.stream).not.toHaveBeenCalled();
  });

  // risk: cross-account disclosure — bytes read during an in-flight principal change are discarded, never returned.
  it('discards an already-read body if the trusted Files principal changes in flight', async() => {
    const principal = vi.fn().mockResolvedValueOnce('human-a').mockResolvedValueOnce('human-a').mockResolvedValueOnce('human-b');
    const client = api({ principal });

    await expect(service(client).read('file-1')).resolves.toEqual({ state:'unavailable', reason:'authority-changed' });
  });

  // risk: range integrity — only a valid zero-based Content-Range matching authorized metadata is accepted.
  it('rejects a mismatched partial-content response', async() => {
    const client = api({
      metadata:fileMetadata({ size:8 }),
      stream:vi.fn(async() => new Response('abcd', { status:206, headers:{ 'content-range':'bytes 1-4/8' } })),
    });

    await expect(service(client).read('file-1')).resolves.toEqual({ state:'unavailable', reason:'invalid-content' });
  });

  // risk: binary disclosure/corruption — malformed UTF-8 or binary controls cannot be surfaced as text.
  it('refuses binary bytes mislabeled as UTF-8 text', async() => {
    const client = api({
      metadata:fileMetadata({ path:'notes.txt', mime:'text/plain', size:2 }),
      stream:vi.fn(async() => new Response(new Uint8Array([0xff, 0xfe]))),
    });

    await expect(service(client).read('file-1')).resolves.toMatchObject({ state:'unsupported', reason:'binary-text' });
  });

  // risk: offline UX — transport failures return a stable non-content state rather than leaking raw errors.
  it('maps a Files outage to an offline state without returning body or error details', async() => {
    const client = api({ json:vi.fn(async() => { throw new Error('private transport details'); }) });

    await expect(service(client).read('file-1')).resolves.toEqual({ state:'offline' });
  });
});

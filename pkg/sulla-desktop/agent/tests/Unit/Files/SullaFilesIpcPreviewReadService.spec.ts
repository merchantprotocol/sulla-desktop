// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
vi.mock('@pkg/window/agentWindowTrust', () => ({ isAgentWindowSender: vi.fn() }));
vi.mock('@pkg/main/sullaFilesClient', () => ({
  FilesApiError: class FilesApiError extends Error {
    constructor(message:string, readonly status:number) { super(message); }
  },
}));

import { isAgentWindowSender } from '@pkg/window/agentWindowTrust';
import { SullaFilesIpcPreviewReadService, SullaFilesPreviewContentClassifier, type SullaFilesPreviewReadCaps } from '@pkg/main/SullaFilesIpcPreviewReadService';

const CAPS:SullaFilesPreviewReadCaps = { html:4, markdown:4, code:4, csv:4, image:4, pdf:1024 };
const metadata = (overrides:Record<string, unknown> = {}) => ({ id:'f', path:'file.md', mime:'text/markdown', size:3, collection_id:'c', current_version_id:'v', deleted_at:null, version:{ id:'v', size:3 }, ...overrides });
const pdfFixture = new Uint8Array(readFileSync(new URL('./fixtures/inline-pdf-fixture.pdf', import.meta.url)));
const pdfMetadata = (size = pdfFixture.byteLength) => metadata({ path:'file.pdf', mime:'application/pdf', size, version:{ id:'v', size } });
const clientFor = (metadataValue:unknown = metadata(), stream = vi.fn(async() => new Response('abc')), principal = vi.fn(async() => 'account-a'), authority = vi.fn(async() => principal())) => ({ json:vi.fn(async() => metadataValue), stream, currentPrincipalId:principal, currentAuthorityId:authority });
const serviceFor = (client:any) => new SullaFilesIpcPreviewReadService({ client } as never, new SullaFilesPreviewContentClassifier(CAPS));

describe('bounded Files preview read', () => {
  it('returns a full HTML source unchanged, including scripts, inline CSS, and relative asset references', async() => {
    // risk: data integrity — HTML preview reads must not strip scripts, styles, or image/font URLs.
    const source = '<!doctype html><html><head><style>@font-face{font-family:PreviewFace;src:url("./fonts/preview.woff2")}</style></head><body style="color:rebeccapurple"><img src="../images/hero.png"><script>window.previewRan = true;</script></body></html>';
    const file = metadata({ path:'Projects/preview/page.html', mime:'text/html', size:source.length, version:{ id:'v', size:source.length } });
    const client = clientFor(file, vi.fn(async() => new Response(source)));
    const service = new SullaFilesIpcPreviewReadService(
      { client } as never,
      new SullaFilesPreviewContentClassifier({ ...CAPS, html:source.length }),
    );

    const result = await service.read('f');

    expect(result).toMatchObject({ state:'ready', kind:'html', truncated:false, content:source });
  });

  it('discards bytes when trusted Files identity changes between metadata and body', async() => {
    const principal = vi.fn().mockResolvedValueOnce('account-a').mockResolvedValueOnce('account-a').mockResolvedValueOnce('account-b');
    const client = clientFor(metadata(), vi.fn(async() => new Response('abc')), principal);
    await expect(serviceFor(client).read('f')).resolves.toEqual({ state:'unavailable', reason:'authority-changed' });
  });

  it('discards bytes when the signed-in org changes between metadata and body', async() => {
    const authority = vi.fn()
      .mockResolvedValueOnce('{\"localPrincipal\":\"local\",\"accountId\":\"account\",\"orgId\":\"org-a\"}')
      .mockResolvedValueOnce('{\"localPrincipal\":\"local\",\"accountId\":\"account\",\"orgId\":\"org-a\"}')
      .mockResolvedValueOnce('{\"localPrincipal\":\"local\",\"accountId\":\"account\",\"orgId\":\"org-b\"}');
    await expect(serviceFor(clientFor(metadata(), vi.fn(async() => new Response('abc')), vi.fn(async() => 'account-a'), authority)).read('f'))
      .resolves.toEqual({ state:'unavailable', reason:'authority-changed' });
  });

  it.each(['pdf', 'image'] as const)('returns no body and makes no Range request for oversized %s', async(kind) => {
    const file = kind === 'pdf' ? metadata({ path:'file.pdf', mime:'application/pdf', size:10_000_000, version:{ id:'v', size:10_000_000 } }) : metadata({ path:'file.png', mime:'image/png', size:10_000_000, version:{ id:'v', size:10_000_000 } });
    const stream = vi.fn();
    const client = clientFor(file, stream);
    const result = await serviceFor(client).read('f');
    expect(result).not.toHaveProperty('content');
    expect(stream).not.toHaveBeenCalled();
    expect(result).toMatchObject({ state:'too-large', kind, maxBytes:CAPS[kind] });
  });

  it('returns authorized in-cap PDF bytes without a Range request', async() => {
    // risk: authorization + data integrity — the inline PDF renderer must receive the complete current version only within the byte cap.
    const stream = vi.fn(async() => new Response(pdfFixture));
    const client = clientFor(pdfMetadata(), stream);
    const result = await serviceFor(client).read('f');

    expect(result).toMatchObject({ state:'ready', kind:'pdf', truncated:false });
    if (result.state !== 'ready') throw new Error('Expected a ready PDF preview.');
    expect(result.content).toEqual(pdfFixture);
    expect(stream).toHaveBeenCalledTimes(1);
    expect(stream.mock.calls[0]?.[1]).toEqual({ method:'GET' });
    expect(client.currentAuthorityId).toHaveBeenCalledTimes(3);
  });

  it('returns an empty PDF byte array for an empty current version without opening a stream', async() => {
    // risk: data integrity — zero-length binary PDFs stay binary and do not trigger a misleading network read.
    const stream = vi.fn();
    const result = await serviceFor(clientFor(pdfMetadata(0), stream)).read('f');

    expect(result).toMatchObject({ state:'ready', kind:'pdf', truncated:false });
    if (result.state !== 'ready') throw new Error('Expected a ready PDF preview.');
    expect(result.content).toEqual(new Uint8Array());
    expect(stream).not.toHaveBeenCalled();
  });

  it('discards PDF bytes if the Files authority changes before the read completes', async() => {
    // risk: permissions — a principal switch must never return previously authorized PDF bytes.
    const authority = vi.fn().mockResolvedValueOnce('account-a').mockResolvedValueOnce('account-a').mockResolvedValueOnce('account-b');
    const stream = vi.fn(async() => new Response(pdfFixture));
    const client = clientFor(pdfMetadata(), stream, vi.fn(async() => 'account-a'), authority);
    const result = await serviceFor(client).read('f');

    expect(result).toEqual({ state:'unavailable', reason:'authority-changed' });
    expect(result).not.toHaveProperty('content');
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it('cancels an authorized PDF body read when the caller aborts', async() => {
    // risk: resource bounds — unmounted/cancelled previews must stop reading body bytes.
    const controller = new AbortController();
    let startStream!: () => void;
    const streamStarted = new Promise<void>(resolve => { startStream = resolve; });
    let cancelled = false;
    const stream = vi.fn(async(_endpoint:string, _init:RequestInit, signal?:AbortSignal) => {
      startStream();
      await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once:true }));
      return new Response(new ReadableStream<Uint8Array>({
        start(streamController) { streamController.enqueue(pdfFixture); },
        cancel() { cancelled = true; },
      }));
    });
    const pending = serviceFor(clientFor(pdfMetadata(), stream)).read('f', { signal:controller.signal });
    await streamStarted;
    controller.abort();
    const result = await pending;

    expect(result).toEqual({ state:'cancelled' });
    expect(stream.mock.calls[0]?.[2]).toBe(controller.signal);
    expect(cancelled).toBe(true);
  });

  it('discards PDF bytes if cancellation arrives during the final authority recheck', async() => {
    // risk: permissions + resource lifecycle — cancellation wins a race with the final identity check.
    const controller = new AbortController();
    let finalCheckStarted!: () => void;
    const finalCheck = new Promise<void>(resolve => { finalCheckStarted = resolve; });
    let releaseFinalCheck!: () => void;
    const finalCheckResult = new Promise<string>(resolve => { releaseFinalCheck = () => resolve('account-a'); });
    const authority = vi.fn()
      .mockResolvedValueOnce('account-a')
      .mockResolvedValueOnce('account-a')
      .mockImplementationOnce(async() => { finalCheckStarted(); return finalCheckResult; });
    const stream = vi.fn(async() => new Response(pdfFixture));
    const pending = serviceFor(clientFor(pdfMetadata(), stream, vi.fn(async() => 'account-a'), authority))
      .read('f', { signal:controller.signal });
    await finalCheck;
    controller.abort();
    releaseFinalCheck();
    const result = await pending;

    expect(result).toEqual({ state:'cancelled' });
    expect(result).not.toHaveProperty('content');
  });

  it('rejects an untrusted sender, subframe, non-string and oversized fileId', async() => {
    const register = vi.fn();
    vi.mocked(isAgentWindowSender).mockReturnValue(false);
    const service = serviceFor(clientFor());
    service.register({ handle:register } as never);
    const handlers = new Map(register.mock.calls.map(([channel, handler]) => [channel, handler]));
    const handler = handlers.get('sulla-files:preview-read')!;
    const cancelHandler = handlers.get('sulla-files:preview-read-cancel')!;
    const mainFrame = { url:'app://.' };
    const event = { sender:{ id:17, mainFrame }, senderFrame:mainFrame };
    await expect(handler(event, { fileId:'f', requestId:'request-1' })).rejects.toThrow('Untrusted');
    expect(() => cancelHandler(event, { requestId:'request-1' })).toThrow('Untrusted');
    vi.mocked(isAgentWindowSender).mockReturnValue(true);
    await expect(handler({ ...event, senderFrame:{} }, { fileId:'f', requestId:'request-1' })).rejects.toThrow('Untrusted');
    await expect(handler(event, { fileId:42, requestId:'request-1' })).rejects.toThrow('Invalid');
    await expect(handler(event, { fileId:'f' })).rejects.toThrow('Invalid');
    await expect(handler(event, { fileId:'x'.repeat(201), requestId:'request-1' })).rejects.toThrow('Invalid');
  });

  it('cancels an active IPC read owned by the invoking agent window', async() => {
    // risk: resource lifecycle — unmounting a file card must abort its main-process Files body request.
    const register = vi.fn();
    const service = serviceFor(clientFor(pdfMetadata(), vi.fn(async(_endpoint:string, _init:RequestInit, signal?:AbortSignal) => {
      startStream();
      await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once:true }));
      return new Response(new ReadableStream<Uint8Array>({ start(streamController) { streamController.enqueue(pdfFixture); } }));
    })));
    service.register({ handle:register } as never);
    const handlers = new Map(register.mock.calls.map(([channel, handler]) => [channel, handler]));
    const readHandler = handlers.get('sulla-files:preview-read')!;
    const cancelHandler = handlers.get('sulla-files:preview-read-cancel')!;
    const mainFrame = { url:'app://.' };
    const event = { sender:{ id:29, mainFrame }, senderFrame:mainFrame };
    let startStream!: () => void;
    const streamStarted = new Promise<void>(resolve => { startStream = resolve; });
    vi.mocked(isAgentWindowSender).mockReturnValue(true);

    const pending = readHandler(event, { fileId:'f', requestId:'request-29' });
    await streamStarted;
    expect(cancelHandler(event, { requestId:'request-29' })).toEqual({ cancelled:true });
    await expect(pending).resolves.toEqual({ state:'cancelled' });
    expect(cancelHandler(event, { requestId:'request-29' })).toEqual({ cancelled:false });
  });
});

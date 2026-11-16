// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SullaFilesIpcMediaService } from './SullaFilesIpcMediaService';

import type { Protocol } from 'electron';
import type { SullaFilesClient } from './sullaFilesClient';

type Handler = (request:Request) => Promise<Response>;

function harness(contentType:string) {
  let handler:Handler | undefined;
  const protocol = {
    isProtocolHandled: vi.fn(() => false),
    handle:            vi.fn((_scheme:string, fn:Handler) => { handler = fn }),
  } as unknown as Protocol;
  const cancel = vi.fn(async() => undefined);
  const stream = vi.fn(async() => ({
    ok: true, status: 200, statusText: 'OK', headers: new Headers({ 'content-type': contentType }), body: { cancel },
  }));
  const service = new SullaFilesIpcMediaService(protocol, { stream } as unknown as SullaFilesClient);
  service.initialize();
  return { service, stream, cancel, fetch: (url:string) => handler!(new Request(url)) };
}

describe('SullaFilesIpcMediaService', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-16T00:00:00Z')) });
  afterEach(() => { vi.useRealTimers() });

  // risk: media previews break mid-session if the capability TTL shrinks from main's 4 hours
  it('keeps a media capability valid for four hours and rejects it afterwards', async() => {
    const { service, stream, fetch } = harness('video/mp4');
    const url = service.capability({ fileId: 'f1', versionId: 'v1' });

    expect(url).toMatch(/^sulla-files-media:\/\/content\/[0-9a-f-]{36}$/);
    vi.advanceTimersByTime(4 * 60 * 60_000 - 1);
    expect((await fetch(url)).status).toBe(200);
    expect(stream).toHaveBeenCalledWith('/v1/files/f1/preview?versionId=v1', expect.objectContaining({ method: 'GET' }), expect.anything());
    vi.advanceTimersByTime(1);
    expect((await fetch(url)).status).toBe(404);
  });

  // risk: expired capability tokens accumulate forever (memory leak) if issuing stops pruning them
  it('prunes expired capabilities when a new one is issued', () => {
    const { service } = harness('video/mp4');
    service.capability({ fileId: 'old-1' });
    service.capability({ fileId: 'old-2' });
    vi.advanceTimersByTime(4 * 60 * 60_000);
    service.capability({ fileId: 'fresh' });
    const live = [...(service as unknown as { capabilities:Map<string, { fileId:string }> }).capabilities.values()];

    expect(live.map(item => item.fileId)).toEqual(['fresh']);
  });

  // risk: tokens must be unique so one file's capability can never serve another file
  it('issues a distinct token per capability', () => {
    const { service } = harness('video/mp4');

    expect(service.capability({ fileId: 'a' })).not.toBe(service.capability({ fileId: 'a' }));
  });

  // risk: security — active content (HTML/SVG) served through the media scheme could script the app; real media must still play
  it.each([
    ['application/pdf', 200],
    ['audio/mp4', 200],
    ['video/x-matroska', 200],
    ['image/png; charset=binary', 200],
    ['text/html', 415],
    ['image/svg+xml', 415],
    ['application/pdfx', 415],
  ])('serves %s with status %i', async(mime, status) => {
    const { service, cancel, fetch } = harness(mime);
    const response = await fetch(service.capability({ fileId: 'f' }));

    expect(response.status).toBe(status);
    if (status === 415) expect(cancel).toHaveBeenCalled();
  });
});

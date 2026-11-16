// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

import { SullaFilesIpcMediaService } from './SullaFilesIpcMediaService';

const HOUR = 60 * 60_000;

function harness(mime:string) {
  let clock = 1_000_000;
  let handler:(request:Request) => Promise<Response> = async() => new Response(null, { status: 500 });
  const protocol = { isProtocolHandled: vi.fn(() => false), handle: vi.fn((_scheme:string, listener:typeof handler) => { handler = listener }) };
  const client = { stream: vi.fn(async() => new Response('bytes', { status: 200, headers: { 'content-type': mime } })) };
  const service = new SullaFilesIpcMediaService(protocol as any, client as any, () => clock);
  service.initialize();

  return {
    service, client,
    advance: (ms:number) => { clock += ms },
    fetch:   (url:string) => handler(new Request(url.replace('sulla-files-media://', 'http://'), { method: 'GET' })),
  };
}

describe('SullaFilesIpcMediaService', () => {
  it('keeps a media capability valid for four hours, then refuses it', async() => {
    // risk: regression — a 60 s TTL broke long video/audio playback and seeking (main uses 4 h).
    const { service, advance, fetch, client } = harness('video/mp4');
    const url = service.capability({ fileId: 'f1', versionId: 'v1' });
    advance(4 * HOUR - 1);
    expect((await fetch(url)).status).toBe(200);
    expect(client.stream).toHaveBeenCalledWith('/v1/files/f1/preview?versionId=v1', expect.objectContaining({ method: 'GET' }), expect.anything());
    advance(1);
    expect((await fetch(url)).status).toBe(404);
  });

  it('prunes expired capabilities when a new one is issued', async() => {
    // risk: unbounded growth / stale grants — expired tokens must be dropped on issue.
    const { service, advance, fetch } = harness('audio/mpeg');
    const old = service.capability({ fileId: 'f1' });
    advance(4 * HOUR);
    const fresh = service.capability({ fileId: 'f2' });
    advance(-4 * HOUR); // even if the clock went backwards, the pruned token stays gone
    expect((await fetch(old)).status).toBe(404);
    expect((await fetch(fresh)).status).toBe(200);
  });

  it.each(['video/x-matroska', 'audio/x-m4a', 'image/png', 'image/webp; q=1', 'application/pdf'])('serves passive media type %s', async(mime) => {
    // risk: regression — main allows any video/* or audio/*, listed images and PDF; narrower lists broke playback.
    const { service, fetch } = harness(mime);
    expect((await fetch(service.capability({ fileId: 'f1' }))).status).toBe(200);
  });

  it.each(['text/html', 'image/svg+xml', 'application/javascript', 'application/pdfx'])('refuses active content type %s', async(mime) => {
    // risk: security — script-capable content must never be served through the media protocol.
    const { service, fetch } = harness(mime);
    expect((await fetch(service.capability({ fileId: 'f1' }))).status).toBe(415);
  });
});

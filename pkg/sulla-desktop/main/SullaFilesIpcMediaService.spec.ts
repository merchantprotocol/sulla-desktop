// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

import { SullaFilesIpcMediaService } from './SullaFilesIpcMediaService';

import type { Protocol } from 'electron';
import type { SullaFilesClient } from './sullaFilesClient';

type Handler = (request:Request) => Promise<Response>;

const HOUR = 60 * 60_000;

function harness(contentType:string) {
  let clock = Date.parse('2026-11-16T00:00:00Z');
  let handler:Handler | undefined;
  const protocol = {
    isProtocolHandled: vi.fn(() => false),
    handle:            vi.fn((_scheme:string, fn:Handler) => { handler = fn }),
  } as unknown as Protocol;
  const cancel = vi.fn(async() => undefined);
  const stream = vi.fn(async() => ({
    ok: true, status: 200, statusText: 'OK', headers: new Headers({ 'content-type': contentType }), body: { cancel },
  }));
  const service = new SullaFilesIpcMediaService(protocol, { stream } as unknown as SullaFilesClient, () => clock);
  service.initialize();

  return {
    service, stream, cancel,
    advance: (ms:number) => { clock += ms },
    fetch:   (url:string) => handler!(new Request(url, { method: 'GET' })),
  };
}

describe('SullaFilesIpcMediaService', () => {
  // risk: regression — a 60 s TTL broke long video/audio playback and seeking (main uses 4 h).
  it('keeps a media capability valid for four hours and rejects it afterwards', async() => {
    const { service, stream, advance, fetch } = harness('video/mp4');
    const url = service.capability({ fileId: 'f1', versionId: 'v1' });

    expect(url).toMatch(/^sulla-files-media:\/\/content\/[0-9a-f-]{36}$/);
    advance(4 * HOUR - 1);
    expect((await fetch(url)).status).toBe(200);
    expect(stream).toHaveBeenCalledWith('/v1/files/f1/preview?versionId=v1', expect.objectContaining({ method: 'GET' }), expect.anything());
    advance(1);
    expect((await fetch(url)).status).toBe(404);
  });

  // risk: expired capability tokens accumulate forever (memory leak) if issuing stops pruning them
  it('prunes expired capabilities when a new one is issued', () => {
    const { service, advance } = harness('video/mp4');
    service.capability({ fileId: 'old-1' });
    service.capability({ fileId: 'old-2' });
    advance(4 * HOUR);
    service.capability({ fileId: 'fresh' });
    const live = [...(service as unknown as { capabilities:Map<string, { fileId:string }> }).capabilities.values()];

    expect(live.map(item => item.fileId)).toEqual(['fresh']);
  });

  // risk: stale grants — a token pruned on issue must stay gone even if the clock later moves backwards.
  it('keeps a pruned capability refused after the clock moves backwards', async() => {
    const { service, advance, fetch } = harness('audio/mpeg');
    const old = service.capability({ fileId: 'f1' });
    advance(4 * HOUR);
    const fresh = service.capability({ fileId: 'f2' });
    advance(-4 * HOUR);

    expect((await fetch(old)).status).toBe(404);
    expect((await fetch(fresh)).status).toBe(200);
  });

  // risk: tokens must be unique so one file's capability can never serve another file
  it('issues a distinct token per capability', () => {
    const { service } = harness('video/mp4');

    expect(service.capability({ fileId: 'a' })).not.toBe(service.capability({ fileId: 'a' }));
  });

  // risk: regression — main allows any video/* or audio/*, listed images and PDF; narrower lists broke playback.
  it.each([
    'video/x-matroska',
    'audio/x-m4a',
    'audio/mp4',
    'image/png',
    'image/png; charset=binary',
    'image/webp; q=1',
    'application/pdf',
  ])('serves passive media type %s', async(mime) => {
    const { service, cancel, fetch } = harness(mime);

    expect((await fetch(service.capability({ fileId: 'f1' }))).status).toBe(200);
    expect(cancel).not.toHaveBeenCalled();
  });

  // risk: security — active content (HTML/SVG/script) served through the media scheme could script the app
  it.each(['text/html', 'image/svg+xml', 'application/javascript', 'application/pdfx'])('refuses active content type %s', async(mime) => {
    const { service, cancel, fetch } = harness(mime);

    expect((await fetch(service.capability({ fileId: 'f1' }))).status).toBe(415);
    expect(cancel).toHaveBeenCalled();
  });
});

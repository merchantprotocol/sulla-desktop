// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { Protocol } from 'electron';
import type { SullaFilesClient } from './sullaFilesClient';

interface MediaCapability { fileId:string; versionId?:string; expiresAt:number }

export class SullaFilesIpcMediaService {
  private readonly capabilities = new Map<string, MediaCapability>();

  constructor(private readonly protocol:Protocol, private readonly filesClient:SullaFilesClient) {}

  capability(input:{fileId:string;versionId?:string}):string {
    const token = crypto.randomUUID();
    this.capabilities.set(token, { ...input, expiresAt:Date.now() + 60_000 });
    return `sulla-files-media://content/${ token }`;
  }

  initialize():void {
    if (this.protocol.isProtocolHandled('sulla-files-media')) return;
    this.protocol.handle('sulla-files-media', async(request) => {
      const url = new URL(request.url);
      if (url.hostname !== 'content' || !['GET', 'HEAD'].includes(request.method)) return new Response(null, { status:404, headers:{ 'cache-control':'no-store' } });
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length !== 1) return new Response(null, { status:404, headers:{ 'cache-control':'no-store' } });
      const capability = this.capabilities.get(parts[0]);
      if (!capability || capability.expiresAt <= Date.now()) {
        this.capabilities.delete(parts[0]);
        return new Response(null, { status:404, headers:{ 'cache-control':'no-store' } });
      }
      const endpoint = `/v1/files/${ encodeURIComponent(capability.fileId) }/preview${ capability.versionId ? `?versionId=${ encodeURIComponent(capability.versionId) }` : '' }`;
      const upstream = await this.filesClient.stream(endpoint, { method:request.method, headers:request.headers.get('range') ? { range:request.headers.get('range')! } : undefined }, request.signal);
      const mime = upstream.headers.get('content-type') ?? '';
      if (upstream.ok && !this.passiveMedia(mime)) {
        await upstream.body?.cancel();
        return new Response(null, { status:415, headers:{ 'cache-control':'no-store' } });
      }
      const headers = new Headers(upstream.headers);
      headers.set('cache-control', 'private, no-store');
      headers.set('x-content-type-options', 'nosniff');
      return new Response(upstream.body, { status:upstream.status, statusText:upstream.statusText, headers });
    });
  }

  private passiveMedia(mime:string):boolean {
    return /^(image\/(?:avif|gif|jpeg|png|webp)|audio\/(?:aac|flac|mpeg|ogg|wav|webm)|video\/(?:mp4|mpeg|ogg|quicktime|webm))$/i.test(mime.split(';', 1)[0].trim());
  }
}

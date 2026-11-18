// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import path from 'node:path';
import type { Protocol } from 'electron';
import { FilesListingPager } from '../agent/files/FilesListingPager';
import { FilesPreviewMimeMap } from './FilesPreviewMimeMap';
import { FilesPreviewPathGuard } from './FilesPreviewPathGuard';
import { FilesPreviewTokenRegistry } from './FilesPreviewTokenRegistry';
import type { SullaFilesIpcApi, SullaFilesIpcRegistrar } from './SullaFilesIpcSupport';

const NAVIGATION_BRIDGE = `<script>(function(){document.addEventListener('click',function(event){var link=event.target&&event.target.closest&&event.target.closest('a[href]');if(!link)return;var href=link.getAttribute('href')||'';if(href.charAt(0)==='#')return;if(/^https?:\\/\\//i.test(href)){event.preventDefault();parent.postMessage({type:'sulla-files-nav',kind:'external',href:href},'*');return}if(/^(mailto:|tel:)/i.test(href))return;if(/^[a-z][a-z\\d+.-]*:/i.test(href)||href.slice(0,2)==='//')return;event.preventDefault();parent.postMessage({type:'sulla-files-nav',kind:'relative',href:href},'*')},true)})()</script>`;

/** App-only capability URLs for sandboxed, read-only HTML preview documents and assets. */
export class SullaFilesIpcPreviewService {
  constructor(
    private readonly protocol:Protocol,
    private readonly api:SullaFilesIpcApi,
    private readonly tokens = new FilesPreviewTokenRegistry(),
    private readonly paths = new FilesPreviewPathGuard(),
    private readonly mime = new FilesPreviewMimeMap(),
  ) {}

  register(ipc:SullaFilesIpcRegistrar):void {
    ipc.handle('files:preview:open', async(event, input:{collectionId:string;fileId?:string;path?:string}) => {
      this.assertApp(event.senderFrame?.url);
      if (!input?.collectionId || (!input.fileId && !input.path)) throw new Error('Choose a Files HTML file');
      // Metadata performs file-read authorization; a collection listing independently proves that
      // the file belongs to the requested collection (a file id alone is not collection authority).
      const file = input.fileId ? await this.api.json(`/v1/files/${ encodeURIComponent(input.fileId) }`) : undefined;
      const filePath = String(file?.path ?? input.path ?? '');
      if (!/\.html?$/i.test(filePath) || this.paths.resolve('', filePath) !== filePath) throw new Error('Choose an HTML file in this collection');
      const parent = path.posix.dirname(filePath) === '.' ? '' : path.posix.dirname(filePath);
      const match = await this.findFile(input.collectionId, parent, filePath);
      if (!match || (input.fileId && String(match.id) !== input.fileId)) throw new Error('Choose an HTML file in this collection');
      if (!file) await this.api.json(`/v1/files/${ encodeURIComponent(String(match.id)) }`);
      const rootFolder = path.posix.dirname(filePath) === '.' ? '' : path.posix.dirname(filePath);
      const rootDocument = rootFolder ? filePath.slice(rootFolder.length + 1) : filePath;
      const token = this.tokens.issue(input.collectionId, rootFolder, rootDocument);
      return { token, url:`sulla-files-preview://${ token }/${ rootDocument.split('/').map(encodeURIComponent).join('/') }` };
    });
    ipc.handle('files:preview:revoke', (event, input:{token:string}) => {
      this.assertApp(event.senderFrame?.url);
      this.tokens.revoke(input.token);
    });
  }

  initialize():void {
    if (this.protocol.isProtocolHandled('sulla-files-preview')) return;
    this.protocol.handle('sulla-files-preview', request => this.serve(request));
  }

  private assertApp(senderUrl?:string):void {
    if (!senderUrl || new URL(senderUrl).protocol !== 'app:') throw new Error('HTML preview URLs are only available to the Sulla application');
  }

  private async findFile(collectionId:string, folder:string, targetPath:string):Promise<any | undefined> {
    for await (const page of FilesListingPager.pages<any>(url => this.api.listingRequest(url), '/v1/files', { collectionId, path:folder, trash:'false' })) {
      const match = page.find(candidate => String(candidate.path) === targetPath);
      if (match) return match;
    }
    return undefined;
  }

  private async serve(request:Request):Promise<Response> {
    const noStore = { 'cache-control':'no-store', 'x-content-type-options':'nosniff' };
    if (request.method !== 'GET') return new Response(null, { status:404, headers:noStore });
    const binding = this.tokens.resolve(new URL(request.url).hostname);
    if (!binding) return new Response(null, { status:403, headers:noStore });
    const relative = new URL(request.url).pathname.slice(1);
    const targetPath = this.paths.resolve(binding.rootFolder, relative);
    if (!targetPath) return new Response(null, { status:404, headers:noStore });
    // Compare decoded paths: the URL pathname stays percent-encoded (e.g. "My%20Page.html").
    const documentPath = binding.rootFolder ? `${ binding.rootFolder }/${ binding.rootDocument }` : binding.rootDocument;
    const folder = path.posix.dirname(targetPath) === '.' ? '' : path.posix.dirname(targetPath);
    let file:any;
    try {
      file = await this.findFile(binding.collectionId, folder, targetPath);
    } catch { return new Response(null, { status:404, headers:noStore }) }
    if (!file?.id) return new Response(null, { status:404, headers:noStore });
    const result = this.mime.get(targetPath);
    const upstream = await this.api.client.stream(`/v1/files/${ encodeURIComponent(String(file.id)) }/preview`);
    if (!upstream.ok) { await upstream.body?.cancel(); return new Response(null, { status:404, headers:noStore }) }
    const headers = new Headers(noStore);
    headers.set('content-type', result.mime);
    if (result.attachment) headers.set('content-disposition', 'attachment');
    let body = upstream.body;
    if (targetPath === documentPath && /\.html?$/i.test(targetPath) && body) {
      const html = await upstream.text();
      const head = /<head(?:\s[^>]*)?>/i.exec(html);
      body = new Blob([head ? html.slice(0, head.index + head[0].length) + NAVIGATION_BRIDGE + html.slice(head.index + head[0].length) : NAVIGATION_BRIDGE + html], { type:result.mime }).stream();
    }
    return new Response(body, { status:200, headers });
  }
}

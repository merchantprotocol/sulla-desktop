// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { SullaFilesIpcPreviewService } from './SullaFilesIpcPreviewService';
import { FilesPreviewTokenRegistry } from './FilesPreviewTokenRegistry';

describe('SullaFilesIpcPreviewService', () => {
  // risk: preview isolation — only the top-level HTML receives the navigation bridge; assets remain untouched.
  it('injects navigation bridge only into the token root HTML document', async() => {
    let handler:((request:Request)=>Promise<Response>)|undefined;
    const protocol = { isProtocolHandled:()=>false, handle:(_scheme:string, callback:typeof handler)=>{ handler=callback } };
    const files = [{ id:'file-html', path:'index.html' }, { id:'file-css', path:'site.css' }];
    const api = {
      listingRequest:async()=>new Response(JSON.stringify(files), { status:200 }),
      client:{ stream:vi.fn(async(endpoint:string)=>new Response(endpoint.includes('file-html')?'<html><head></head><body></body></html>':'body{}', { status:200 })) },
      json:vi.fn(),
    };
    const tokens = new FilesPreviewTokenRegistry();
    const service = new SullaFilesIpcPreviewService(protocol as never, api as never, tokens);
    service.initialize();
    const token = tokens.issue('collection', '', 'index.html');
    const fetchPreview = (path:string) => handler!({ url:`sulla-files-preview://${token}/${path}`, method:'GET' } as Request);
    const html = await (await fetchPreview('index.html')).text();
    const css = await (await fetchPreview('site.css')).text();
    expect(html).toContain("kind:'relative'");
    expect(css).not.toContain('sulla-files-nav');
  });
});

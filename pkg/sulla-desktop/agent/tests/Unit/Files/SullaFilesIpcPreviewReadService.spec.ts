// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { SullaFilesIpcPreviewReadService, SullaFilesPreviewContentClassifier, type SullaFilesPreviewReadCaps } from '@pkg/main/SullaFilesIpcPreviewReadService';

const CAPS:SullaFilesPreviewReadCaps = { html:4, markdown:4, code:4, csv:4, image:4, pdf:4 };
const metadata = (overrides:Record<string, unknown> = {}) => ({ id:'f', path:'file.md', mime:'text/markdown', size:3, collection_id:'c', current_version_id:'v', deleted_at:null, version:{ id:'v', size:3 }, ...overrides });
const clientFor = (metadataValue:unknown = metadata(), stream = vi.fn(async() => new Response('body')), principal = vi.fn(async() => 'account-a'), authority = vi.fn(async() => principal())) => ({ json:vi.fn(async() => metadataValue), stream, currentPrincipalId:principal, currentAuthorityId:authority });
const serviceFor = (client:any) => new SullaFilesIpcPreviewReadService({ client } as never, new SullaFilesPreviewContentClassifier(CAPS));

describe('bounded Files preview read', () => {
  it('discards bytes when trusted Files identity changes between metadata and body', async() => {
    const principal = vi.fn().mockResolvedValueOnce('account-a').mockResolvedValueOnce('account-a').mockResolvedValueOnce('account-b');
    const client = clientFor(metadata(), vi.fn(async() => new Response('body')), principal);
    await expect(serviceFor(client).read('f')).resolves.toEqual({ state:'unavailable', reason:'authority-changed' });
  });

  it('discards bytes when the signed-in org changes between metadata and body', async() => {
    const authority = vi.fn()
      .mockResolvedValueOnce('{\"localPrincipal\":\"local\",\"accountId\":\"account\",\"orgId\":\"org-a\"}')
      .mockResolvedValueOnce('{\"localPrincipal\":\"local\",\"accountId\":\"account\",\"orgId\":\"org-a\"}')
      .mockResolvedValueOnce('{\"localPrincipal\":\"local\",\"accountId\":\"account\",\"orgId\":\"org-b\"}');
    await expect(serviceFor(clientFor(metadata(), vi.fn(async() => new Response('body')), vi.fn(async() => 'account-a'), authority)).read('f'))
      .resolves.toEqual({ state:'unavailable', reason:'authority-changed' });
  });

  it.each(['pdf', 'image'])('returns no body and makes no Range request for oversized %s', async(kind) => {
    const file = kind === 'pdf' ? metadata({ path:'file.pdf', mime:'application/pdf', size:10_000_000, version:{ id:'v', size:10_000_000 } }) : metadata({ path:'file.png', mime:'image/png', size:10_000_000, version:{ id:'v', size:10_000_000 } });
    const stream = vi.fn();
    const client = clientFor(file, stream);
    const result = await serviceFor(client).read('f');
    expect(result).not.toHaveProperty('content');
    expect(stream).not.toHaveBeenCalled();
    expect(result.state).toBe(kind === 'pdf' ? 'metadata-only' : 'too-large');
  });

  it('rejects an untrusted sender, subframe, non-string and oversized fileId', async() => {
    const register = vi.fn();
    const service = serviceFor(clientFor());
    service.register({ handle:register } as never);
    const handler = register.mock.calls[0][1];
    const mainFrame = { url:'app://.' };
    await expect(handler({ sender:{ mainFrame }, senderFrame:mainFrame }, { fileId:'f' })).rejects.toThrow('Untrusted');
    await expect(handler({ sender:{ mainFrame }, senderFrame:{} }, { fileId:'f' })).rejects.toThrow('Untrusted');
    await expect(handler({ sender:{ mainFrame }, senderFrame:mainFrame }, { fileId:42 })).rejects.toThrow('Invalid');
    await expect(handler({ sender:{ mainFrame }, senderFrame:mainFrame }, { fileId:'x'.repeat(201) })).rejects.toThrow('Invalid');
  });
});

import { describe, expect, it } from 'vitest';
import { FilesListSharedWorker } from '../../../tools/files/list_shared';
import { FilesShareToOrgWorker } from '../../../tools/files/share_to_org';

class FakeListSharedWorker extends FilesListSharedWorker {
  constructor(private readonly collections: any[], private readonly rows: any[] = []) { super(); }
  protected async containerJson<T>(path: string): Promise<T> { return (path === '/v1/collections' ? this.collections : this.rows) as T; }
  protected async containerRequest(): Promise<Response> { return new Response(JSON.stringify(this.rows)); }
}
class FakeShareToOrgWorker extends FilesShareToOrgWorker {
  writes: any[] = [];
  constructor(private readonly collections: any[]) { super(); }
  protected async containerJson<T>(path: string): Promise<T> {
    if (path === '/v1/collections') return this.collections as T;
    if (path.includes('/v1/files/')) return { path: 'Reports/current.txt', mime: 'text/plain' } as T;
    throw new Error(`Unexpected API call ${path}`);
  }
  protected async resolvePath(): Promise<any> { return { fileId: 'source-id' }; }
  protected async containerRequest(path: string, _input: unknown, init: RequestInit = {}): Promise<Response> {
    if (path.endsWith('/download')) return new Response('current bytes');
    this.writes.push({ path, init });
    return new Response(JSON.stringify({ path: 'inbox/current.txt', versionId: 'new-version' }), { status: 201 });
  }
}
const organization = { id: 'org-collection', workspaceScope: 'organization', orgId: 'org-1', orgName: 'Acme', name: 'Shared', level: 'edit' };

describe('organization Files tools', () => {
  it('lists only visible organization collections with their organization mount paths', async () => {
    const worker = new FakeListSharedWorker([organization, { id: 'personal', name: 'Home', workspaceScope: 'principal' }]);
    const result = await (worker as any)._validatedCall({});
    expect(JSON.parse(result.responseString)).toEqual([{ collectionId: 'org-collection', orgId: 'org-1', orgName: 'Acme', name: 'Shared', level: 'edit', path: '/mnt/sulla-files/Organizations/Acme/Shared' }]);
  });

  it('copies the current source through Files API into the selected editable org collection', async () => {
    const worker = new FakeShareToOrgWorker([organization]);
    const result = await (worker as any)._validatedCall({ source: '/mnt/sulla-files/Reports/current.txt', collectionId: 'org-collection', folder: 'inbox' });
    expect(JSON.parse(result.responseString)).toEqual({ collectionId: 'org-collection', path: 'inbox/current.txt', versionId: 'new-version' });
    expect(worker.writes).toHaveLength(1);
    expect(worker.writes[0].path).toContain('collectionId=org-collection');
    expect(worker.writes[0].init.body).toBeInstanceOf(ArrayBuffer);
  });

  it('refuses view-level collection writes with actionable guidance', async () => {
    const worker = new FakeShareToOrgWorker([{ ...organization, level: 'view' }]);
    await expect((worker as any)._validatedCall({ source: 'x', collectionId: 'org-collection' })).rejects.toThrow('You can view Shared but not add files to it; ask an org admin for edit');
  });

  it('refuses unknown collections and never targets a personal collection', async () => {
    const worker = new FakeShareToOrgWorker([{ id: 'personal', name: 'Home', workspaceScope: 'principal', level: 'manage' }]);
    await expect((worker as any)._validatedCall({ source: 'x', collectionId: 'personal' })).rejects.toThrow('Use files/list_shared');
    expect(worker.writes).toHaveLength(0);
  });
});

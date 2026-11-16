// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// Drives the real DesktopFilesDataSource against an in-memory Files API that pages exactly like
// GET /v1/files (250-row keyset pages, children=true matches the parent folder exactly).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ipc = vi.hoisted(() => ({ handler: (_channel:string, _input:any):Promise<unknown> => Promise.resolve(undefined) }));
vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: { invoke: (channel:string, input:any) => ipc.handler(channel, input), on: () => undefined, removeListener: () => undefined, send: () => undefined } }));
vi.mock('electron', () => ({ webUtils: {} }));

import { DesktopFilesDataSource } from '@pkg/pages/files/DesktopFilesDataSource';
import { FilesSectionSource, FolderSummaryIndex } from '@pkg/pages/files/FilesCrossFolderViews';
import { aggregateFolderChildren } from '@pkg/pages/files/fileAggregation';
import type { FilesItem } from '@pkg/pages/files/types';

interface ApiFile { id:string; collection_id:string; path:string; current_version_id:string; size:number; updated_at:string; deleted_at?:string; created_by_type:string; created_by_id:string; extraction_status:string }

/** In-memory stand-in for the Files service HTTP API reached through IPC. */
class FakeFilesApi {
  static readonly pageSize = 250;
  readonly files:ApiFile[] = [];
  readonly calls:{ channel:string; input:any }[] = [];
  private readonly gates = new Map<string, Promise<void>>();

  add(paths:string[], extra:Partial<ApiFile> = {}):void {
    for (const path of paths) {
      const n = this.files.length;
      this.files.push({ id: `f${ n }`, collection_id: 'c1', path, current_version_id: `v${ n }`, size: 10, updated_at: new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString(), created_by_type: 'user', created_by_id: 'u1', extraction_status: 'indexed', ...extra });
    }
  }

  /** Hold list-page responses for `path` (only its continuation pages when `laterPages`) until released. */
  hold(path:string, laterPages = false):() => void {
    let release!:() => void; const key = laterPages ? `${ path }|more` : path;
    this.gates.set(key, new Promise<void>(resolve => { release = resolve }));
    return () => { this.gates.delete(key); release() };
  }

  pageCalls(path:string):any[] { return this.calls.filter(call => call.channel === 'sulla-files:list-page' && call.input.path === path) }

  async invoke(channel:string, input:any):Promise<unknown> {
    this.calls.push({ channel, input });
    const active = this.files.filter(file => !file.deleted_at);
    switch (channel) {
    case 'sulla-files:collections': return [{ id: 'c1', name: 'Files', access_role: 'manage' }];
    case 'files-ui:status': return { state: 'synced', pendingFiles: 0, serverConfigured: true };
    case 'files-preferences:list-roots': return [{ id: 'default', name: 'Files', collectionId: 'c1', activation: 'active', state: 'idle' }];
    case 'files-ui:capabilities': return {};
    case 'sulla-files:operation-capabilities': return { enabled: false };
    case 'sulla-files:trash-list': return [];
    case 'sulla-files:folders': return [];
    case 'sulla-files:stats': return { fileCount: active.length, totalBytes: active.reduce((sum, file) => sum + file.size, 0), agentRunCount: new Set(active.filter(file => file.created_by_type === 'agent-run').map(file => file.created_by_id)).size, indexing: { total: active.length, pending: 0, indexing: 0, indexed: active.length, partial: 0, unsupported: 0, failed: 0, complete: true } };
    case 'sulla-files:recent': return [...active].filter(file => !input.createdByType || file.created_by_type === input.createdByType).sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, Math.min(200, input.limit));
    case 'sulla-files:metadata': { const file = this.files.find(item => item.id === input.fileId); if (!file) throw new Error('not found'); return file }
    case 'sulla-files:list-page': {
      await this.gates.get(input.cursor ? `${ input.path ?? '' }|more` : input.path ?? '');
      const path = input.path ?? ''; const after = input.cursor ? Buffer.from(input.cursor, 'base64url').toString('utf8') : '';
      const parent = (value:string) => value.includes('/') ? value.slice(0, value.lastIndexOf('/')) : '';
      const matches = active.filter(file => (input.children ? parent(file.path) === path : !path || file.path.startsWith(`${ path }/`)) && file.path > after).sort((a, b) => a.path < b.path ? -1 : 1);
      const page = matches.slice(0, FakeFilesApi.pageSize); const hasMore = matches.length > FakeFilesApi.pageSize;
      return { files: page, hasMore, nextCursor: hasMore ? Buffer.from(page.at(-1)!.path, 'utf8').toString('base64url') : null };
    }
    default: return undefined;
    }
  }
}

const range = (count:number, make:(index:number) => string) => Array.from({ length: count }, (_, index) => make(index));
const pad = (index:number) => String(index).padStart(6, '0');

describe('DesktopFilesDataSource folder-scoped listing', () => {
  let api:FakeFilesApi;
  let source:DesktopFilesDataSource;

  beforeEach(async() => {
    api = new FakeFilesApi();
    ipc.handler = (channel, input) => api.invoke(channel, input);
    source = new DesktopFilesDataSource();
  });

  // risk: data loss — the old whole-collection loader stopped at 20,000 rows, so later folders looked empty.
  it('shows every file of a folder that sorts after 20,000+ other paths', async() => {
    api.add(range(20_500, index => `aaa/file-${ pad(index) }.txt`));
    api.add(['zzz/one.md', 'zzz/two.md', 'zzz/three.md']);
    await source.load();
    const files = await source.loadFolder('zzz');
    expect(files.map(file => file.path)).toEqual(['zzz/one.md', 'zzz/three.md', 'zzz/two.md']);
    expect(api.pageCalls('zzz')).toHaveLength(1);
    expect(api.pageCalls('aaa')).toHaveLength(0);
  });

  // risk: wrong folder contents — a slow response for the previous folder must never replace the folder now open.
  it('drops a stale response after navigating from A to B', async() => {
    api.add(['A/a1.md', 'A/a2.md']);
    api.add(['B/b1.md']);
    await source.load();
    const emitted:string[][] = [];
    source.onFolderFilesChanged(files => emitted.push(files.map(file => file.path)));
    const release = api.hold('A');
    const staleA = source.loadFolder('A');
    const filesB = await source.loadFolder('B');
    release();
    const resolvedA = await staleA;
    expect(filesB.map(file => file.path)).toEqual(['B/b1.md']);
    expect(resolvedA.map(file => file.path)).not.toContain('A/a1.md');
    expect((await source.loadMore()).map(file => file.path)).toEqual(['B/b1.md']);
    expect(emitted.flat()).not.toContain('A/a1.md');
  });

  // risk: wrong folder contents — background page completion for A must stop once B is open.
  it('stops completing the previous folder\'s pages after navigation', async() => {
    api.add(range(600, index => `A/file-${ pad(index) }.md`));
    api.add(['B/only.md']);
    await source.load();
    const emitted:string[] = [];
    const releaseA = api.hold('A', true);
    await source.loadFolder('A');
    source.onFolderFilesChanged(files => emitted.push(...files.map(file => file.path)));
    expect((await source.loadFolder('B')).map(file => file.path)).toEqual(['B/only.md']);
    releaseA();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect((await source.loadMore()).map(file => file.path)).toEqual(['B/only.md']);
    expect(emitted.filter(path => path.startsWith('A/'))).toEqual([]);
    expect(api.pageCalls('A').filter(call => call.input.cursor)).toHaveLength(1);
  });

  // risk: data loss — a folder larger than one page must finish loading without the user scrolling.
  it('auto-completes a 600-row folder across pages', async() => {
    api.add(range(600, index => `big/file-${ pad(index) }.md`));
    api.add(['big/nested/deep.md', 'big-sibling/x.md']);
    await source.load();
    let latest:FilesItem[] = [];
    source.onFolderFilesChanged(files => { latest = files });
    const first = await source.loadFolder('big');
    expect(first).toHaveLength(250);
    await vi.waitFor(() => expect(latest).toHaveLength(600));
    expect(new Set(latest.map(file => file.path)).size).toBe(600);
    expect(latest.map(file => file.path)).toEqual(range(600, index => `big/file-${ pad(index) }.md`));
    expect(api.pageCalls('big')).toHaveLength(3);
  });

  // risk: misleading figures — the header count, storage and agent badge must cover the collection, not the open folder.
  it('takes collection totals and index coverage from the server, not the loaded rows', async() => {
    api.add(range(700, index => `deep/folder/file-${ pad(index) }.md`));
    api.add(['top.md']);
    api.add(['agents/run.md'], { created_by_type: 'agent-run', created_by_id: 'run-7' });
    const snapshot = await source.load();
    expect(snapshot.files.map(file => file.path)).toEqual(['top.md']);
    expect(snapshot.collection.fileCount).toBe(702);
    expect(snapshot.collection.totalBytes).toBe(7020);
    expect(snapshot.collection.agentRunCount).toBe(1);
    expect(snapshot.status.indexing.total).toBe(702);
  });

  // risk: Trash without folder receipts would trash only the loaded rows of a folder, leaving the rest behind.
  it('lists a folder\'s whole subtree across pages for folder Trash', async() => {
    api.add(range(300, index => `trash-me/sub/file-${ pad(index) }.md`));
    api.add(['trash-me/top.md', 'trash-me-not/keep.md']);
    await source.load();
    const tree = await source.listFolderTree('trash-me');
    expect(tree).toHaveLength(301);
    expect(tree.map(file => file.path)).not.toContain('trash-me-not/keep.md');
  });
});

describe('cross-folder views', () => {
  let api:FakeFilesApi;
  let source:DesktopFilesDataSource;

  beforeEach(async() => {
    api = new FakeFilesApi();
    ipc.handler = (channel, input) => api.invoke(channel, input);
    source = new DesktopFilesDataSource();
  });

  // risk: Recent / Agent files / Starred silently showing only the open folder's files.
  it('reads Recent, Agent files and Starred from their own server sources', async() => {
    api.add(range(80, index => `old/file-${ pad(index) }.md`));
    api.add(['elsewhere/agent-made.md'], { created_by_type: 'agent-run', created_by_id: 'run-1' });
    api.add(['elsewhere/newest.md']);
    await source.load();
    await source.loadFolder('old');
    const sections = new FilesSectionSource(source);
    const recent = await sections.load('recent', []);
    expect(recent).toHaveLength(FilesSectionSource.recentLimit);
    expect(recent[0].path).toBe('elsewhere/newest.md');
    expect((await sections.load('agent', [])).map(file => file.path)).toEqual(['elsewhere/agent-made.md']);
    const newestId = api.files.find(file => file.path === 'elsewhere/newest.md')!.id;
    expect((await sections.load('starred', [newestId, 'folder:old', 'missing-id'])).map(file => file.path)).toEqual(['elsewhere/newest.md']);
  });

  it('falls back to the loaded rows only for sources without server views', () => {
    const sections = new FilesSectionSource({});
    expect(sections.supports('recent')).toBe(false);
    expect(sections.supports('starred')).toBe(false);
  });

  // risk: a folder row reading "0 files" while it holds files, or an implicit folder disappearing.
  it('overlays server folder totals and never reports an unknown count as 0', () => {
    const aggregation = aggregateFolderChildren([], '');
    aggregation.folders.set('docs', { name: 'docs', path: 'docs', count: 0, size: 0, newestTimestamp: 0, allAgent: true, hasConflict: false, hasSyncing: false, allOnlineOnly: true });
    aggregation.folders.set('empty', { name: 'empty', path: 'empty', count: 0, size: 0, newestTimestamp: 0, allAgent: true, hasConflict: false, hasSyncing: false, allOnlineOnly: true });
    const unknown = new FolderSummaryIndex(true).apply(aggregation, '');
    expect(unknown.folders.get('docs')!.count).toBe(-1);
    const loaded = new FolderSummaryIndex(true).set('', [
      { path: 'docs', name: 'docs', fileCount: 1234, totalBytes: 99, updatedAt: '2026-05-01T00:00:00.000Z' },
      { path: 'implicit', name: 'implicit', fileCount: 3, totalBytes: 3, updatedAt: null },
    ]).apply(aggregation, '');
    expect(loaded.folders.get('docs')).toMatchObject({ count: 1234, size: 99, allAgent: false, allOnlineOnly: false });
    expect(loaded.folders.get('empty')!.count).toBe(0);
    expect(loaded.folders.get('implicit')).toMatchObject({ path: 'implicit', count: 3 });
    expect(new FolderSummaryIndex(false).apply(aggregation, '').folders.get('docs')!.count).toBe(0);
  });
});

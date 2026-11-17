// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// risk: data accuracy. Opening a document inside a folder must resolve that exact file, not a root
// file with the same name, and must not report it missing when it exists.
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ webUtils: { getPathForFile: () => '' }, ipcRenderer: {} }));
vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: {} }));

import { DesktopFilesDataSource } from './DesktopFilesDataSource';

const file = (id:string, path:string, extra:Record<string, unknown> = {}) => ({ id, path, current_version_id: `v-${ id }`, ...extra });

/** Serves the root listing, one folder listing per path, and metadata by id. */
class FakeIpc {
  constructor(private readonly folders:Record<string, object[]>, private readonly byId:Record<string, object>) {}
  readonly metadataCalls:string[] = [];
  readonly listCalls:string[] = [];

  invoke = (channel:string, input?:any):Promise<unknown> => {
    if (channel === 'files-ui:native-runtime') return Promise.resolve({ state: 'disabled', ready: false, generation: 0, sourceGrant: 'unsupported' });
    if (channel === 'sulla-files:list-page') {
      this.listCalls.push(input.path);
      return Promise.resolve({ files: this.folders[input.path] ?? [], nextCursor: null, hasMore: false });
    }
    if (channel === 'sulla-files:metadata') {
      this.metadataCalls.push(input.fileId);
      return this.byId[input.fileId] ? Promise.resolve(this.byId[input.fileId]) : Promise.reject(new Error('not found'));
    }
    return Promise.resolve(undefined);
  };

  on = () => this;
  removeListener = () => this;
  send = () => undefined;
}

describe('DesktopFilesDataSource.resolveFile', () => {
  it('finds a nested file by id through metadata without listing its folder', async() => {
    const nested = file('n1', 'Notes/Deep/plan.md');
    const ipc = new FakeIpc({ '': [file('r1', 'readme.md')] }, { n1: nested });
    const source = new DesktopFilesDataSource(ipc as never);
    source.selectCollection('c1');

    const resolved = await source.resolveFile({ fileId: 'n1', path: 'Notes/Deep/plan.md' }, [file('r1', 'readme.md') as never]);

    expect(resolved?.id).toBe('n1');
    expect(resolved?.path).toBe('Notes/Deep/plan.md');
    expect(ipc.metadataCalls).toEqual(['n1']);
    expect(ipc.listCalls).toEqual([]);
  });

  it('falls back to the parent folder by path when metadata cannot find the id', async() => {
    const nested = file('n2', 'Notes/Deep/todo.md');
    const ipc = new FakeIpc({ 'Notes/Deep': [nested], '': [] }, {});
    const source = new DesktopFilesDataSource(ipc as never);
    source.selectCollection('c1');

    const resolved = await source.resolveFile({ fileId: 'missing', path: 'Notes/Deep/todo.md' }, []);

    expect(resolved?.id).toBe('n2');
    expect(ipc.listCalls).toContain('Notes/Deep');
  });

  it('never returns a deleted file and reports a truly missing file as null', async() => {
    const trashed = file('d1', 'Notes/gone.md', { deleted_at: '2026-11-01T00:00:00Z' });
    const ipc = new FakeIpc({ 'Notes': [trashed] }, { d1: trashed });
    const source = new DesktopFilesDataSource(ipc as never);
    source.selectCollection('c1');

    expect(await source.resolveFile({ fileId: 'd1', path: 'Notes/gone.md' }, [])).toBeNull();
  });
});

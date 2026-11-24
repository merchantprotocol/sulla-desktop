// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import CitationRow from '@pkg/pages/chat/components/citation/CitationRow.vue';
import { SupportingReportResolver } from '@pkg/pages/chat/services/SupportingReportResolver';

const f = vi.hoisted(() => ({ invoke: vi.fn(), openTab: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: { invoke: (...args: any[]) => f.invoke(...args) } }));
vi.mock('@pkg/composables/useBrowserTabs', () => ({ openWorkspaceTab: f.openTab }));
const source = { num: 1, title: 'Frontend safety audit', origin: 'Projects/qa/audit.md' };
const file = { id: 'file-a', path: source.origin, collection_id: 'files' };
beforeEach(() => {
  vi.clearAllMocks();
  f.invoke.mockImplementation(async(channel: string) => {
    await Promise.resolve();
    if (channel === 'sulla-files:collections') return [{ id: 'files' }];
    if (channel === 'sulla-files:list-page') return { files: [file], hasMore: false };
    if (channel === 'sulla-files:metadata') return file;
    throw Error('Unexpected request');
  });
});

describe('supporting report resolution', () => {
  it('uses exact paths and pages through the existing Files listing', async() => {
    f.invoke.mockImplementation(async(channel: string, input: any) => {
      await Promise.resolve();
      if (channel === 'sulla-files:collections') return [{ id: 'files' }];
      if (channel === 'sulla-files:list-page') return input.cursor ? { files: [file], hasMore: false } : { files: [{ ...file, id: 'other', path: 'Another/audit.md' }], hasMore: true, nextCursor: 'next' };
    });
    const resolver = new SupportingReportResolver({ invoke: f.invoke });
    expect(await resolver.file(source)).toEqual({ fileId: 'file-a', path: source.origin, collectionId: 'files' });
    expect(f.invoke).toHaveBeenCalledWith('sulla-files:list-page', { collectionId: 'files', path: 'Projects/qa', children: true, cursor: 'next' });
  });

  it('refuses ambiguous, absent and moved reports rather than opening another file', async() => {
    const resolver = new SupportingReportResolver({ invoke: f.invoke });
    f.invoke.mockImplementation((channel: string) => Promise.resolve(channel === 'sulla-files:collections' ? [{ id: 'files' }, { id: 'other' }] : { files: [file], hasMore: false }));
    await expect(resolver.file(source)).rejects.toThrow('More than one');
    f.invoke.mockImplementation((channel: string) => Promise.resolve(channel === 'sulla-files:collections' ? [{ id: 'files' }] : { files: [], hasMore: false }));
    await expect(resolver.file(source)).rejects.toThrow('not available');
    f.invoke.mockResolvedValue({ ...file, path: 'Different/report.md' });
    await expect(resolver.verify({ fileId: file.id, path: file.path, collectionId: 'files' })).rejects.toThrow('moved');
  });

  it('does not treat unsafe URLs or host paths as navigation targets', async() => {
    const resolver = new SupportingReportResolver({ invoke: f.invoke });
    expect(resolver.webUrl({ ...source, url: 'https://example.com/report' })).toBe('https://example.com/report');
    for (const url of ['#', 'javascript:alert(1)', 'file:///Users/private/report.md']) expect(resolver.webUrl({ ...source, url })).toBeUndefined();
    for (const origin of ['/Users/private/report.md', '../private.md', 'Projects/../private.md']) await expect(resolver.file({ ...source, origin })).rejects.toThrow('no saved Files');
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it('fails clearly if pagination cannot complete', async() => {
    const resolver = new SupportingReportResolver({ invoke: f.invoke });
    f.invoke.mockResolvedValueOnce([{ id: 'files' }]).mockResolvedValue({ files: [], hasMore: true, nextCursor: 'same' });
    await expect(resolver.file(source)).rejects.toThrow('finish checking');
  });
});

describe('supporting report citation formats', () => {
  interface Row { id: string; path: string; deleted_at?: string; collection_id?: string }
  const report = 'Projects/ripplecore-performance-audit/postmortem-admin-speed-build-2026-11-23.md';
  const folderSource = { num: 1, title: 'postmortem-admin-speed-build-2026-11-23.md', origin: 'Projects/ripplecore-performance-audit' };
  /** A small Files store: collections hold rows; list-page returns a folder's direct files, metadata looks up by id. */
  function files(collections: Record<string, Row[]>) {
    f.invoke.mockImplementation(async(channel: string, input: any) => {
      await Promise.resolve();
      if (channel === 'sulla-files:collections') return Object.keys(collections).map(id => ({ id }));
      if (channel === 'sulla-files:list-page') return { files: (collections[input.collectionId] ?? []).filter(row => input.children ? row.path.slice(0, row.path.lastIndexOf('/')) === input.path : row.path.startsWith(`${ input.path }/`)), hasMore: false };
      if (channel === 'sulla-files:metadata') {
        for (const [collectionId, rows] of Object.entries(collections)) {
          const row = rows.find(item => item.id === input.fileId);
          if (row) return { collection_id: collectionId, ...row };
        }
        throw Error("Error invoking remote method 'sulla-files:metadata': Error: file not found");
      }
      throw Error('Unexpected request');
    });
    return new SupportingReportResolver({ invoke: f.invoke });
  }

  it('opens a report cited as folder origin plus file-name title', async() => {
    const resolver = files({ files: [{ id: 'pm', path: report }, { id: 'brief', path: 'Projects/ripplecore-performance-audit/BRIEF-admin-speed.md' }] });
    expect(await resolver.file(folderSource)).toEqual({ fileId: 'pm', path: report, collectionId: 'files' });
    expect(await resolver.file({ ...folderSource, title: 'BRIEF-admin-speed.md' })).toEqual({ fileId: 'brief', path: 'Projects/ripplecore-performance-audit/BRIEF-admin-speed.md', collectionId: 'files' });
  });

  it('still opens the old full-path origin, but refuses when origin plus title also matches', async() => {
    expect(await files({ files: [{ id: 'pm', path: report }] }).file({ ...folderSource, origin: report })).toMatchObject({ fileId: 'pm' });
    const both = files({ files: [{ id: 'pm', path: report }, { id: 'nested', path: `${ report }/${ folderSource.title }` }] });
    await expect(both.file({ ...folderSource, origin: report })).rejects.toThrow('More than one');
  });

  it('refuses rather than opening another collection\'s file that sits at the folder path', async() => {
    const folder = 'Projects/ripplecore-performance-audit';
    await expect(files({ a: [{ id: 'pm', path: report }], b: [{ id: 'unrelated', path: folder }] }).file(folderSource)).rejects.toThrow('More than one');
    expect(await files({ a: [{ id: 'pm', path: report }], b: [{ id: 'unrelated', path: `${ folder }-old` }] }).file(folderSource)).toEqual({ fileId: 'pm', path: report, collectionId: 'a' });
    expect(f.openTab).not.toHaveBeenCalled();
  });

  it('opens origin plus title in the same collection when only that path matches', async() => {
    const resolver = files({ files: [{ id: 'pm', path: report }, { id: 'sibling', path: 'Projects/ripplecore-performance-audit.md' }] });
    expect(await resolver.file(folderSource)).toEqual({ fileId: 'pm', path: report, collectionId: 'files' });
  });

  it('keeps origin-only matching when the title is not a plain file name', async() => {
    const resolver = files({ a: [{ id: 'pm', path: report }], b: [{ id: 'folder-file', path: 'Projects/ripplecore-performance-audit' }] });
    expect(await resolver.file({ ...folderSource, title: 'Audit / postmortem' })).toEqual({ fileId: 'folder-file', path: 'Projects/ripplecore-performance-audit', collectionId: 'b' });
  });

  it('opens a sulla-file link by id, and falls back to the path rules when the id is missing or deleted', async() => {
    const resolver = files({ files: [{ id: 'pm', path: report }, { id: 'gone', path: 'Old/report.md', deleted_at: '2026-11-01' }], team: [{ id: 'linked', path: 'Team/linked.md' }] });
    expect(await resolver.file({ ...folderSource, url: 'sulla-file://linked?version=v1&path=Team%2Flinked.md&name=linked.md' })).toEqual({ fileId: 'linked', path: 'Team/linked.md', collectionId: 'team' });
    for (const url of ['sulla-file://unknown?path=x.md', 'sulla-file://gone?path=Old%2Freport.md', 'sulla-file://linked.md?path=x.md', 'sulla-file://linked/../x']) {
      expect(await resolver.file({ ...folderSource, url }), url).toMatchObject({ fileId: 'pm' });
    }
    expect(f.invoke.mock.calls.filter(([channel]: any[]) => channel === 'sulla-files:metadata').map(([, input]: any[]) => input.fileId)).toEqual(['linked', 'unknown', 'gone']);
    await expect(resolver.file({ ...folderSource, title: 'missing.md', url: 'sulla-file://gone' })).rejects.toThrow('not available');
  });

  it('never falls back to another path when the linked file cannot be checked', async() => {
    const resolver = files({ files: [{ id: 'other', path: report }], team: [{ id: 'linked', path: 'Team/linked.md' }] });
    const listing = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation((channel: string, input: any) => channel === 'sulla-files:metadata' ? Promise.reject(Error('Files request timed out')) : listing(channel, input));
    await expect(resolver.file({ ...folderSource, url: 'sulla-file://linked?path=Team%2Flinked.md' })).rejects.toThrow('Please retry');
    expect(f.invoke).not.toHaveBeenCalledWith('sulla-files:list-page', expect.anything());
  });

  it('checks only the cited folder, not every file below a broad parent', async() => {
    const crowd = Array.from({ length: 30 }, (_, index) => ({ id: `n${ index }`, path: `Projects/other-${ index }/${ folderSource.title }` }));
    const resolver = files({ files: [...crowd, { id: 'pm', path: report }] });
    expect(await resolver.file(folderSource)).toMatchObject({ fileId: 'pm' });
    expect(f.invoke.mock.calls.filter(([channel]: any[]) => channel === 'sulla-files:list-page').every(([, input]: any[]) => input.children === true)).toBe(true);
  });

  it('refuses a missing file and an ambiguous folder plus title match', async() => {
    await expect(files({ files: [{ id: 'pm', path: report }] }).file({ ...folderSource, title: 'nope.md' })).rejects.toThrow('not available');
    await expect(files({ files: [{ id: 'a', path: report }], team: [{ id: 'b', path: report }] }).file(folderSource)).rejects.toThrow('More than one');
    expect(f.openTab).not.toHaveBeenCalled();
  });

  it('never joins unsafe titles or origins into another file', async() => {
    const resolver = files({ files: [{ id: 'pm', path: report }, { id: 'up', path: 'Projects/secret.md' }, { id: 'sub', path: 'Projects/ripplecore-performance-audit/x/secret.md' }] });
    for (const title of ['..', '.', '', '../secret.md', 'x/secret.md', 'x\\secret.md', '/Users/seth/secret.md', 'file:///Users/seth/secret.md', 'javascript:alert(1)', ' postmortem-admin-speed-build-2026-11-23.md', 'postmortem 🚀.md']) {
      await expect(resolver.file({ ...folderSource, title }), title).rejects.toThrow('not available');
    }
    for (const origin of ['/Users/seth/Projects', 'file:///Users/seth', 'javascript:alert(1)', 'Projects/..', '..', '']) {
      await expect(resolver.file({ ...folderSource, origin }), origin).rejects.toThrow('no saved Files');
    }
    expect(f.invoke.mock.calls.every(([, input]: any[]) => !input?.path || !/^\/|:/.test(input.path))).toBe(true);
  });

  it('keeps https citations as web sources', () => {
    const resolver = files({});
    expect(resolver.webUrl({ ...folderSource, url: 'https://example.com/report' })).toBe('https://example.com/report');
    expect(resolver.webUrl({ ...folderSource, url: 'sulla-file://pm?path=x.md' })).toBeUndefined();
  });

  it('opens a folder plus title citation from the Read report control', async() => {
    files({ files: [{ id: 'pm', path: report }] });
    const wrapper = mount(CitationRow, { props: { msg: { sources: [folderSource] } as any } });
    await wrapper.find('button').trigger('click'); await flushPromises();
    expect(wrapper.find('[role=alert]').exists()).toBe(false);
    expect(f.openTab).toHaveBeenCalledWith({ mode: 'paper', documentFile: { fileId: 'pm', path: report, collectionId: 'files' } });
    wrapper.unmount();
  });
});

describe('supporting report controls', () => {
  it('opens the verified inline report through the existing Files editor', async() => {
    const wrapper = mount(CitationRow, { props: { msg: { id: 'citation', kind: 'citation', sources: [source] } as any } });
    expect(wrapper.find('a[href="#"]').exists()).toBe(false);
    expect(f.invoke).not.toHaveBeenCalled();
    await wrapper.find('button').trigger('click'); await flushPromises();
    expect(f.openTab).toHaveBeenCalledWith({ mode: 'paper', documentFile: { fileId: file.id, path: file.path, collectionId: 'files' } });
    expect(f.invoke).toHaveBeenCalledWith('sulla-files:metadata', { fileId: file.id });
    wrapper.unmount();
  });

  it('retains the current view and explains a missing report', async() => {
    f.invoke.mockRejectedValue(Error('Files is still starting. Please retry.'));
    const wrapper = mount(CitationRow, { props: { msg: { sources: [source] } as any } });
    await wrapper.find('button').trigger('click'); await flushPromises();
    expect(wrapper.find('[role=alert]').text()).toContain('Please retry');
    expect(f.openTab).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});

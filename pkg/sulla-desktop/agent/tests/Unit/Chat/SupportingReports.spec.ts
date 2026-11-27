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
    expect(f.invoke).toHaveBeenCalledWith('sulla-files:list-page', expect.objectContaining({ collectionId: 'files', path: 'Projects/qa', cursor: 'next' }));
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

  // risk: data accuracy — citation folder and filename must resolve to the exact saved report.
  it('opens a report cited as folder origin plus file-name title', async() => {
    const resolver = files({ files: [{ id: 'pm', path: report }, { id: 'brief', path: 'Projects/ripplecore-performance-audit/BRIEF-admin-speed.md' }] });
    expect(await resolver.file(folderSource)).toEqual({ fileId: 'pm', path: report, collectionId: 'files' });
    expect(await resolver.file({ ...folderSource, title: 'BRIEF-admin-speed.md' })).toEqual({ fileId: 'brief', path: 'Projects/ripplecore-performance-audit/BRIEF-admin-speed.md', collectionId: 'files' });
  });

  // risk: policy — ambiguous citation paths must never choose an arbitrary file.
  it('refuses when a full-path origin and its origin-plus-title candidate both match', async() => {
    const both = files({ files: [{ id: 'pm', path: report }, { id: 'nested', path: report + '/' + folderSource.title }] });
    await expect(both.file({ ...folderSource, origin: report })).rejects.toThrow('More than one');
  });

  // risk: policy — a file in another collection cannot mask a folder citation.
  it('refuses a cross-collection file-versus-folder clash at the folder path', async() => {
    const folder = 'Projects/ripplecore-performance-audit';
    const resolver = files({ a: [{ id: 'pm', path: report }], b: [{ id: 'folder-file', path: folder }] });
    await expect(resolver.file(folderSource)).rejects.toThrow('More than one');
  });

  // risk: data accuracy — prose titles must not be mistaken for relative filenames.
  it('still opens an old full-path citation with a prose title containing a slash when no folder clashes', async() => {
    const resolver = files({ a: [{ id: 'pm', path: report }], b: [{ id: 'other', path: 'Projects/ripplecore-performance-audit-old/notes.md' }] });
    expect(await resolver.file({ ...folderSource, origin: report, title: 'Admin speed / postmortem' })).toEqual({ fileId: 'pm', path: report, collectionId: 'a' });
  });

  // risk: data accuracy — durable file links must reopen the linked record, not a guessed path.
  it('opens a sulla-file citation by its durable file id', async() => {
    const resolver = files({ team: [{ id: 'linked', path: 'Team/linked.md' }] });
    expect(await resolver.file({ ...folderSource, url: 'sulla-file://linked?version=v1&path=Team%2Flinked.md&name=linked.md' })).toEqual({ fileId: 'linked', path: 'Team/linked.md', collectionId: 'team' });
    expect(f.invoke.mock.calls.filter(([channel]: any[]) => channel === 'sulla-files:metadata').map(([, input]: any[]) => input.fileId)).toEqual(['linked']);
  });

  // risk: policy — a Files outage must not silently route a citation to a different document.
  it('never falls back to another path when the linked file cannot be checked', async() => {
    const resolver = files({ files: [{ id: 'other', path: report }], team: [{ id: 'linked', path: 'Team/linked.md' }] });
    const listing = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation((channel: string, input: any) => channel === 'sulla-files:metadata' ? Promise.reject(Error('Files request timed out')) : listing(channel, input));
    await expect(resolver.file({ ...folderSource, url: 'sulla-file://linked?path=Team%2Flinked.md' })).rejects.toThrow('Please retry');
    expect(f.invoke).not.toHaveBeenCalledWith('sulla-files:list-page', expect.anything());
  });

  // risk: policy — collection ambiguity must not select another customer's copy.
  it('refuses a folder-plus-title match present in multiple collections', async() => {
    const resolver = files({ a: [{ id: 'a', path: report }], team: [{ id: 'b', path: report }] });
    await expect(resolver.file(folderSource)).rejects.toThrow('More than one');
  });

  // risk: policy — citation text cannot escape its Files path or become a host/URL target.
  it('refuses unsafe title joins and scheme-based origins', async() => {
    const folder = 'Projects/ripplecore-performance-audit';
    const resolver = files({ files: [
      { id: 'pm', path: report },
      { id: 'up', path: folder + '/../secret.md' },
      { id: 'nested', path: folder + '/x/secret.md' },
      { id: 'file-scheme', path: folder + '/file:///Users/x' },
      { id: 'javascript-scheme', path: folder + '/javascript:alert(1)' },
    ] });
    for (const title of ['../secret.md', 'x/secret.md', 'file:///Users/x', 'javascript:alert(1)']) {
      await expect(resolver.file({ ...folderSource, title }), title).rejects.toThrow('not available');
    }
    await expect(resolver.file({ ...folderSource, origin: 'javascript:alert(1)' })).rejects.toThrow('no saved Files');
  });

  // risk: data accuracy — the user-facing Read report action must open the resolved file.
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

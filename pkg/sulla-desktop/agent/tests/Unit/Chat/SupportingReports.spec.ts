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
    expect(f.invoke).toHaveBeenCalledWith('sulla-files:list-page', { collectionId: 'files', path: 'Projects/qa', cursor: 'next' });
  });

  it('refuses ambiguous, absent and moved reports rather than opening another file', async() => {
    const resolver = new SupportingReportResolver({ invoke: f.invoke });
    f.invoke.mockResolvedValueOnce([{ id: 'files' }, { id: 'other' }]).mockResolvedValue({ files: [file], hasMore: false });
    await expect(resolver.file(source)).rejects.toThrow('More than one');
    f.invoke.mockResolvedValueOnce([{ id: 'files' }]).mockResolvedValue({ files: [], hasMore: false });
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

describe('supporting report controls', () => {
  it('starts collapsed and opens the verified document through the existing Files editor', async() => {
    const wrapper = mount(CitationRow, { props: { msg: { id: 'citation', kind: 'citation', sources: [source] } as any } });
    expect(wrapper.find('details').attributes('open')).toBeUndefined();
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

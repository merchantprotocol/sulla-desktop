// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later

import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  dataSource: undefined as any,
  ipc: {
    invoke: vi.fn(),
    send: vi.fn(),
    sendSync: vi.fn(),
    on: vi.fn().mockReturnThis(),
    once: vi.fn().mockReturnThis(),
    removeListener: vi.fn().mockReturnThis(),
    removeAllListeners: vi.fn().mockReturnThis(),
  },
}));

vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: state.ipc, default: state.ipc }));
vi.mock('../DesktopFilesDataSource', () => ({
  DesktopFilesDataSource: class {
    constructor() { return state.dataSource }
  },
}));

import { SyntheticFilesDataSource } from '../SyntheticFilesDataSource';

describe('Files page open routing in a hosted tab', () => {
  let unmount:(() => void) | undefined;

  afterEach(() => {
    unmount?.();
    unmount = undefined;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/');
  });

  it('opens Markdown in the owner tab host and opens video in the mounted media detail', async() => {
    class TestResizeObserver {
      observe():void {}
      disconnect():void {}
    }

    vi.stubGlobal('ResizeObserver', TestResizeObserver);
    window.history.replaceState({}, '', '/?tabHost=1&tabId=files-tab&windowKey=main');
    state.dataSource = new SyntheticFilesDataSource();
    state.ipc.sendSync.mockReturnValue({ id: 'files-tab', url: 'about:blank', title: 'File Manager', favicon: '', loading: false, mode: 'files' });

    // FilesPage is the real BrowserTab screen; the datasource is the shipped
    // synthetic adapter so the test touches no user files or Files service.
    const { default: FilesPage } = await import('../../FilesPage.vue');
    const wrapper = mount(FilesPage, { props: { tabId: 'files-tab', navigation: { path: 'Projects/Alpha' } } });
    unmount = () => wrapper.unmount();
    await flushPromises();
    await flushPromises();

    const markdownRow = wrapper.findAll('tr.row').find(row => row.text().includes('meeting-notes.md'));
    expect(markdownRow, 'the synthetic Files row should be mounted').toBeDefined();
    const originalRow = markdownRow!.element;
    await markdownRow!.trigger('click');
    await flushPromises();
    const rowAfterFirstClick = wrapper.findAll('tr.row').find(row => row.text().includes('meeting-notes.md'));
    expect(rowAfterFirstClick?.element, 'selection must not replace the row before the double-click').toBe(originalRow);
    await rowAfterFirstClick!.trigger('click');
    await rowAfterFirstClick!.trigger('dblclick');
    await flushPromises();

    const markdownName = wrapper.findAll('tr.row').find(row => row.text().includes('meeting-notes.md'))!.find('b');
    await markdownName.trigger('click');
    await markdownName.trigger('click');
    await markdownName.trigger('dblclick');
    await flushPromises();

    expect(state.ipc.invoke).toHaveBeenCalledWith('internal-tab-view:open-workspace-tab', {
      mode: 'paper',
      documentFile: { fileId: 'synthetic-notes', path: 'Projects/Alpha/meeting-notes.md', collectionId: 'synthetic-collection' },
    });
    expect(state.ipc.invoke.mock.calls.filter(([channel]) => channel === 'internal-tab-view:open-workspace-tab')).toHaveLength(2);

    const videoRow = wrapper.findAll('tr.row').find(row => row.text().includes('demo-recording.mp4'));
    expect(videoRow, 'the synthetic video row should be mounted').toBeDefined();
    await videoRow!.find('b').trigger('contextmenu', { button: 2, clientX: 120, clientY: 140 });
    await flushPromises();
    const openInSulla = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(button => button.textContent?.trim() === 'Open in Sulla');
    expect(openInSulla, 'the row action menu should expose Open in Sulla').toBeDefined();
    openInSulla!.click();
    await flushPromises();

    expect(wrapper.find('[aria-label="Synthetic media preview"]').exists(), 'Open in Sulla must render the video media preview').toBe(true);
  });
});

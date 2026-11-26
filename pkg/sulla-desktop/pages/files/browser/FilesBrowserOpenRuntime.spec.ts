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
  let navigateTabListener:((event:Event) => void) | undefined;

  afterEach(() => {
    unmount?.();
    unmount = undefined;
    if (navigateTabListener) window.removeEventListener('sulla:navigate-tab', navigateTabListener);
    navigateTabListener = undefined;
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

    const { openWorkspaceTab, useBrowserTabs } = await import('@pkg/composables/useBrowserTabs');
    const ownerFocusedTabIds:string[] = [];
    navigateTabListener = event => ownerFocusedTabIds.push((event as CustomEvent<{ tabId:string }>).detail.tabId);
    window.addEventListener('sulla:navigate-tab', navigateTabListener);
    const hostedUrl = `${ window.location.pathname }${ window.location.search }${ window.location.hash }`;
    state.ipc.invoke.mockImplementation(async(channel:string, request?:any) => {
      if (channel !== 'internal-tab-view:open-workspace-tab') return undefined;
      // Simulate the actual owner renderer's AgentRouter handler after the
      // main process forwards this tab-host IPC request.
      window.history.replaceState({}, '', '/?windowKey=main');
      try { await openWorkspaceTab(request) } finally { window.history.replaceState({}, '', hostedUrl) }
      return undefined;
    });

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
    const openedPaperTabs = useBrowserTabs().tabs.filter(tab => tab.mode === 'paper' && tab.documentFile?.fileId === 'synthetic-notes');
    expect(openedPaperTabs).toHaveLength(1);
    expect(openedPaperTabs[0].documentFile).toEqual({ fileId: 'synthetic-notes', path: 'Projects/Alpha/meeting-notes.md', collectionId: 'synthetic-collection' });
    expect(ownerFocusedTabIds).toEqual([openedPaperTabs[0].id, openedPaperTabs[0].id]);

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

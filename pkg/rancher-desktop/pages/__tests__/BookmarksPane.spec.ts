/* eslint-disable @typescript-eslint/require-await -- async mocks stand in for IPC */
import fs from 'fs';
import path from 'path';

import { jest } from '@jest/globals';
import { compileScript, parse } from '@vue/compiler-sfc';
import { flushPromises, mount } from '@vue/test-utils';
import ts from 'typescript';
import * as vue from 'vue';

const mockRows = [
  { id: 'a', parent_id: null, kind: 'bookmark', title: 'Alpha', url: 'https://alpha.test/', favicon: null, position: 1, created_at: '', updated_at: '' },
  { id: 'b', parent_id: null, kind: 'bookmark', title: 'Bravo', url: 'https://bravo.test/', favicon: null, position: 2, created_at: '', updated_at: '' },
  { id: 'f', parent_id: null, kind: 'folder', title: 'Work', url: null, favicon: null, position: 3, created_at: '', updated_at: '' },
  { id: 'c', parent_id: 'f', kind: 'bookmark', title: 'Charlie', url: 'https://charlie.test/', favicon: null, position: 1, created_at: '', updated_at: '' },
];
const mockInvoke = jest.fn(async(channel: string): Promise<any> => (channel === 'bookmarks:list' ? mockRows : undefined));
const invoke = mockInvoke;
const push = jest.fn(async() => undefined);

jest.unstable_mockModule('@pkg/utils/ipcRenderer', () => ({
  ipcRenderer: { invoke: (...args: [string]) => mockInvoke(...args), on: () => undefined, send: () => undefined, removeListener: () => undefined },
}));

let Component: any;
let tabsApi: any;

beforeAll(async() => {
  localStorage.clear();
  const useBrowserTabs = await import('@pkg/composables/useBrowserTabs');
  const useBookmarks = await import('@pkg/composables/useBookmarks');
  tabsApi = useBrowserTabs.useBrowserTabs();

  // Same approach as DecidePage.spec: the legacy Jest Vue transform can't do
  // <script setup>, so compile the real SFC with Vue's compiler.
  const source = fs.readFileSync(path.resolve('pkg/rancher-desktop/pages/bookmarks/BookmarksPane.vue'), 'utf8');
  const compiled = compileScript(parse(source).descriptor, { id: 'bookmarks-test', inlineTemplate: true });
  const js = ts.transpileModule(compiled.content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const module = { exports: {} as any };
  const dependencies: Record<string, any> = {
    vue,
    'vue-router':                      { useRouter: () => ({ push }) },
    '@pkg/composables/useBookmarks':   useBookmarks,
    '@pkg/composables/useBrowserTabs': useBrowserTabs,
    '@pkg/utils/ipcRenderer':          { ipcRenderer: { invoke: (...args: [string]) => mockInvoke(...args), on: () => undefined, send: () => undefined, removeListener: () => undefined } },
  };
  // eslint-disable-next-line no-new-func, @typescript-eslint/no-implied-eval -- evaluates the SFC compiled above
  new Function('require', 'module', 'exports', js)((name: string) => {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency ${ name }`);

    return dependencies[name];
  }, module, module.exports);
  Component = module.exports.default;
});

const rowByTitle = (wrapper: any, title: string) => wrapper.findAll('.bm-row').find((r: any) => r.find('.bm-label').text() === title);

test('clicking through bookmarks reuses one preview tab and the pane stays open', async() => {
  const navigations: any[] = [];
  const onNavigate = (e: Event) => navigations.push((e as CustomEvent).detail);
  window.addEventListener('sulla:tab-navigate', onNavigate);

  const wrapper = mount(Component, { props: { activeTab: undefined }, attachTo: document.body });
  await flushPromises();

  expect(wrapper.findAll('.bm-row').map((r: any) => r.find('.bm-label').text())).toEqual(['Alpha', 'Bravo', 'Work']);

  await rowByTitle(wrapper, 'Alpha').trigger('click');
  await rowByTitle(wrapper, 'Bravo').trigger('click');

  const browserTabs = tabsApi.tabs.filter((t: any) => t.mode === 'browser');
  expect(browserTabs).toHaveLength(1);
  const previewId = tabsApi.previewTabId.value;
  expect(previewId).toBe(browserTabs[0].id);
  expect(browserTabs[0].url).toBe('https://bravo.test/');
  expect(navigations).toEqual([{ tabId: previewId, url: 'https://bravo.test/' }]);
  expect(push).toHaveBeenLastCalledWith(`/Browser/${ previewId }`);
  expect(wrapper.find('.bm').exists()).toBe(true);

  // Folder click expands in place and doesn't touch the tab.
  await rowByTitle(wrapper, 'Work').trigger('click');
  expect(rowByTitle(wrapper, 'Charlie')).toBeTruthy();
  expect(tabsApi.previewTabId.value).toBe(previewId);

  // Double-click keeps the tab; the next bookmark opens a fresh preview tab.
  await rowByTitle(wrapper, 'Bravo').trigger('dblclick');
  expect(tabsApi.previewTabId.value).toBeNull();
  await rowByTitle(wrapper, 'Charlie').trigger('click');
  const after = tabsApi.tabs.filter((t: any) => t.mode === 'browser');
  expect(after).toHaveLength(2);
  expect(after.find((t: any) => t.id === previewId).url).toBe('https://bravo.test/');
  expect(tabsApi.previewTabId.value).not.toBe(previewId);

  window.removeEventListener('sulla:tab-navigate', onNavigate);
  wrapper.unmount();
});

test('bookmark-this-page is disabled for non-web tabs and saves the active page otherwise', async() => {
  const chat = mount(Component, { props: { activeTab: { id: 't1', url: 'about:blank', title: 'Chat', mode: 'chat' } } });
  await flushPromises();
  expect(chat.find('button[aria-label="Bookmark this page"]').attributes('disabled')).toBeDefined();
  chat.unmount();

  const page = mount(Component, { props: { activeTab: { id: 't2', url: 'https://delta.test/page', title: 'Delta', mode: 'browser' } } });
  await flushPromises();
  invoke.mockClear();
  await page.find('button[aria-label="Bookmark this page"]').trigger('click');
  await flushPromises();
  expect(invoke).toHaveBeenCalledWith('bookmarks:create', { kind: 'bookmark', url: 'https://delta.test/page', title: 'Delta', parentId: null, tabId: 't2' });
  page.unmount();
});

test('shows a live Docker section whose links preview like bookmarks but cannot be edited', async() => {
  localStorage.removeItem('sulla:bookmarks-expanded');
  const original = mockInvoke.getMockImplementation();
  mockInvoke.mockImplementation(async(channel: string) => {
    if (channel === 'bookmarks:docker-links') {
      return { available: true, links: [{ id: 'docker:app:5199', container: 'app', title: 'app', url: 'http://localhost:5199/' }] };
    }

    return channel === 'bookmarks:list' ? mockRows : undefined;
  });

  const wrapper = mount(Component, { props: { activeTab: undefined } });
  await flushPromises();

  const labels = wrapper.findAll('.bm-row').map((r: any) => r.find('.bm-label').text());
  expect(labels.slice(0, 2)).toEqual(['Docker (1)', 'app']);

  const appRow = rowByTitle(wrapper, 'app');
  expect(appRow.attributes('draggable')).toBe('false');
  expect(appRow.find('button[aria-label="Delete"]').exists()).toBe(false);

  await appRow.trigger('click');
  expect(tabsApi.tabs.find((t: any) => t.id === tabsApi.previewTabId.value).url).toBe('http://localhost:5199/');

  wrapper.unmount();
  mockInvoke.mockImplementation(original!);
});

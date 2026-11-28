// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, onUnmounted, provide, ref } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';

import { WindowTabStripState, windowTabStripKey } from './WindowTabStripState';
import { useBrowserTabs } from './useBrowserTabs';

import AgentHeader from '@pkg/pages/agent/AgentHeader.vue';
import TabStripTab from '@pkg/pages/agent/TabStripTab.vue';

const ipc = vi.hoisted(() => ({
  send:   vi.fn(),
  invoke: vi.fn(() => Promise.resolve([])),
  events: undefined as EventEmitter | undefined,
}));

vi.mock('@pkg/agent', () => ({ getExtensionService: () => ({ getHeaderMenuItems: () => [] }) }));
vi.mock('@pkg/utils/ipcRenderer', async() => {
  const { EventEmitter } = await import('node:events');
  const events = new EventEmitter();

  ipc.events = events;
  return {
    ipcRenderer: {
      send:           ipc.send,
      invoke:         ipc.invoke,
      on:             events.on.bind(events),
      once:           events.once.bind(events),
      removeListener: events.removeListener.bind(events),
    },
  };
});

const store = useBrowserTabs();

async function mountShell(count = 1) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes:  [{ path: '/Browser/:id', component: { render: () => null } }],
  });

  await router.push(`/Browser/${ store.tabs[0].id }`);
  const generation = ref(0);
  const tabProps = new Map<string, InstanceType<typeof TabStripTab>['$props']>();
  const state = new WindowTabStripState(window, ipc.events!);
  const app = createApp({
    setup: () => {
      provide(windowTabStripKey, state);
      state.connect();
      onUnmounted(() => state.dispose());
      return () => Array.from({ length: count }, (_, header) => h(AgentHeader, {
        key:         `${ header }:${ generation.value }`,
        isDark:      true,
        toggleTheme: () => {},
      }));
    },
  });
  const root = document.body.appendChild(document.createElement('div'));

  app.mixin({
    mounted() {
      if (this.$.type !== TabStripTab) return;
      const props = this.$props;

      tabProps.set(props.tab.id, props);
    },
  });
  app.use(router).mount(root);
  const unmount = () => { app.unmount(); root.remove() };

  shells.push(unmount);
  await nextTick();
  return { root, router, tabProps, state, replaceHeaders: () => { generation.value++ } };
}

const shells: (() => void)[] = [];

describe('window tab state with real AgentHeaders', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    });
    ipc.send.mockClear();
  });

  afterEach(() => {
    shells.splice(0).forEach(unmount => unmount());
    for (const tab of [...store.tabs]) store.releaseTab(tab.id);
    vi.unstubAllGlobals();
  });

  it('keeps the working ring and independent attention state after replacing the header without new IPC', async() => {
    const chat = store.createTab('about:blank', { mode: 'chat' });
    const shell = await mountShell();
    const headerTabId = `browser-${ chat.id }`;
    const original = shell.tabProps.get(headerTabId);

    ipc.events!.emit('internal-tab-view:chat-running', {}, chat.id, true, { state: 'you' });
    await nextTick();
    expect(original?.tab).toMatchObject({ working: true, activity: 'you' });

    shell.replaceHeaders();
    await nextTick();
    const replacement = shell.tabProps.get(headerTabId);

    expect(replacement).not.toBe(original);
    expect(replacement?.tab).toMatchObject({ working: true, activity: 'you' });
    expect(ipc.events!.listenerCount('internal-tab-view:chat-running')).toBe(1);

    ipc.events!.emit('internal-tab-view:chat-running', {}, chat.id, false);
    await nextTick();
    expect(replacement?.tab).toMatchObject({ working: false, activity: 'you' });
  });

  it('does not assign a group when a tab changes page mode', async() => {
    // risk: data integrity — a page mode change must not silently create membership.
    const selected = store.createTab('about:blank', { mode: 'welcome' });
    const { router, tabProps } = await mountShell();

    expect(store.tabGroupModel.groups).toEqual([]);
    store.updateTab(selected.id, { mode: 'chat', title: 'New Chat' });
    await nextTick();

    expect(router.currentRoute.value.params.id).toBe(selected.id);
    expect(tabProps.get(`browser-${ selected.id }`)?.tab).toMatchObject({ mode: 'chat', isActive: true });
    expect(store.tabGroupModel.getGroupIdForTab(`browser-${ selected.id }`)).toBeUndefined();
    expect(store.tabGroupModel.groups).toEqual([]);
  });

  it('deleting a group ungroups its tabs without closing them', () => {
    // risk: side effects — deleting organization metadata must never close browser tabs.
    const first = store.createTab('https://first.test');
    const second = store.createTab('https://second.test');
    const group = store.tabGroupModel.createGroup('Research', 'accent', [`browser-${ first.id }`]);

    expect(store.tabGroupModel.deleteGroup(group.id)).toBe(true);
    expect(store.tabs.map(tab => tab.id)).toContain(first.id);
    expect(store.tabs.map(tab => tab.id)).toContain(second.id);
    expect(store.tabGroupModel.getGroupIdForTab(`browser-${ first.id }`)).toBeUndefined();
    expect(store.tabGroupModel.groupTabs(store.tabs.map(tab => ({ id: `browser-${ tab.id }` }))).ungrouped)
      .toContainEqual({ id: `browser-${ first.id }` });
  });

  it('removes the last-tab group when a grouped browser tab closes', async() => {
    // risk: data integrity — closing one tab must prune its membership without touching siblings.
    const selected = store.createTab('https://selected.test');
    const sibling = store.createTab('https://sibling.test');
    const group = store.tabGroupModel.createGroup('Temporary', 'status-success', [`browser-${ selected.id }`]);

    expect(await store.closeTab(selected.id)).toBe(true);
    expect(store.tabs.map(tab => tab.id)).not.toContain(selected.id);
    expect(store.tabs.map(tab => tab.id)).toContain(sibling.id);
    expect(store.tabGroupModel.groups.some(candidate => candidate.id === group.id)).toBe(false);
  });

  it('duplicates exactly once with two mounted headers and a repeated menu reply', async() => {
    const tab = store.createTab('https://example.test');
    const { root } = await mountShell(2);
    const links = root.querySelectorAll(`[data-tab-id="browser-${ tab.id }"]`);

    expect(links).toHaveLength(2);
    links[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    const [, request] = ipc.send.mock.calls.find(([channel]) => channel === 'tab-context-menu:show')!;

    expect(ipc.events!.listenerCount('tab-context-menu:selected')).toBe(1);
    ipc.events!.emit('tab-context-menu:selected', {}, request.requestId, 'duplicate');
    ipc.events!.emit('tab-context-menu:selected', {}, request.requestId, 'duplicate');
    expect(store.tabs.map(current => current.url)).toEqual([tab.url, tab.url]);
  });

  it('activates a Needs-you row exactly once with two mounted headers', async() => {
    store.createTab('https://example.test');
    const chat = store.createTab('about:blank', { mode: 'chat' });
    const { root, router } = await mountShell(2);
    const push = vi.spyOn(router, 'push');

    ipc.events!.emit('internal-tab-view:chat-running', {}, chat.id, false, { state: 'stalled' });
    await nextTick();
    expect(root.querySelector('[aria-haspopup="menu"]')).toBeNull();

    ipc.events!.emit('internal-tab-view:chat-running', {}, chat.id, true, { state: 'you' });
    await nextTick();
    const button = root.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
    const anchor = DOMRect.fromRect({ x: 10, y: 10, width: 60, height: 28 });

    button.style.visibility = 'visible';
    vi.spyOn(button, 'getClientRects').mockReturnValue(Object.assign([anchor], { item: () => anchor }));
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue(anchor);
    button.click();
    const [, request] = ipc.send.mock.calls.find(([channel]) => channel === 'tab-context-menu:show')!;

    ipc.events!.emit('tab-context-menu:selected', {}, request.requestId, `attention:browser-${ chat.id }`);
    ipc.events!.emit('tab-context-menu:selected', {}, request.requestId, `attention:browser-${ chat.id }`);
    expect(push).toHaveBeenCalledExactlyOnceWith(`/Browser/${ chat.id }`);
    await push.mock.results[0].value;
    await nextTick();
    expect(router.currentRoute.value.params.id).toBe(chat.id);
    ipc.events!.emit('internal-tab-view:chat-running', {}, chat.id, false);
  });

  it.each(['closeRight', 'closeOther'])('leaves the surviving tabs untouched on %s after its target disappears', async(action) => {
    const left = store.createTab('https://left.test');
    const target = store.createTab('https://target.test');
    const right = store.createTab('https://right.test');
    const { root } = await mountShell();

    root.querySelector(`[data-tab-id="browser-${ target.id }"]`)!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    const [, request] = ipc.send.mock.calls.find(([channel]) => channel === 'tab-context-menu:show')!;

    store.releaseTab(target.id);
    await nextTick();
    ipc.events!.emit('tab-context-menu:selected', {}, request.requestId, action);
    await nextTick();
    expect(store.tabs.map(tab => tab.id)).toEqual([left.id, right.id]);
  });
});

// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
import { flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ChatFileCard from '@pkg/pages/chat/components/files/ChatFileCard.vue';
import { parseDurableFileReferences } from '@pkg/shared/filesReferences';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

vi.mock('@pkg/pages/chat/controller/useChatController', () => ({ useChatController: () => ({ thread: { value: { id: 'synthetic-chat' } } }) }));
vi.mock('@pkg/utils/ipcRenderer', () => ({
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn(), send: vi.fn(), sendSync: vi.fn() },
}));

const fileId = '00000000-0000-4000-8000-000000000001';
const canonical = `sulla-file://${fileId}?version=fixture-v1&name=note.pdf&path=Fake%2Fnote.pdf`;
const bare = `sulla-file://${fileId}`;
let card:VueWrapper | undefined;

beforeEach(() => {
  window.history.replaceState({}, '', '/?tabHost=1');
  vi.mocked(ipcRenderer.invoke).mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  card?.unmount();
  window.history.replaceState({}, '', '/');
});

describe('chat Files card workspace handoff', () => {
  // risk: wrong version or no action when a chat is isolated from its owner.
  it.each([
    ['click', canonical, 'fixture-v1', 'Fake/note.pdf'],
    ['keydown', canonical, 'fixture-v1', 'Fake/note.pdf'],
    ['keyup', bare, undefined, fileId],
    ['click', bare, undefined, fileId],
  ] as const)('opens a synthetic reference in the owner on %s', async(event, link, versionId, path) => {
    const [reference] = parseDurableFileReferences(link);
    card = shallowMount(ChatFileCard, { props: { reference } });
    await card.get('button[aria-label]').trigger(event, { key: event === 'keydown' ? 'Enter' : ' ' });
    expect(ipcRenderer.invoke).toHaveBeenCalledExactlyOnceWith('internal-tab-view:open-workspace-tab', {
      mode: 'files', title: 'File Manager',
      filesNavigation: { fileId, path, section: 'detail', ...(versionId ? { versionId } : {}) },
    });
  });

  // risk: the inner action bubbling to the card's Open or escaping the review path.
  it.each([
    ['History', 'versions', canonical, 'fixture-v1', 'Fake/note.pdf'],
    ['Link latest', 'share-review', canonical, 'fixture-v1', 'Fake/note.pdf'],
    ['Link', 'share-review', bare, undefined, fileId],
  ] as const)('requests only %s via native keyboard button activation', async(label, section, link, versionId, path) => {
    const [reference] = parseDurableFileReferences(link);
    card = shallowMount(ChatFileCard, { props: { reference } });
    // Browsers dispatch click with detail=0 for native keyboard button activation.
    const button = card.findAll('button').find(button => button.text() === label)!;
    button.element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, detail: 0 }));
    await flushPromises();
    expect(ipcRenderer.invoke).toHaveBeenCalledExactlyOnceWith('internal-tab-view:open-workspace-tab', {
      mode: 'files', title: 'File Manager',
      filesNavigation: { fileId, path, section, ...(versionId ? { versionId } : {}) },
    });
  });

  // risk: bad input or broken IPC silently looks successful (or discloses bridge internals).
  it('reports malformed references and bridge rejection without an extra action', async() => {
    const [reference] = parseDurableFileReferences(canonical);
    const [malformed] = parseDurableFileReferences(`${bare}/wrong`);
    card = shallowMount(ChatFileCard, { props: { reference: malformed } });
    await card.get('button[aria-label]').trigger('click');
    expect(card.get('[role=alert]').text()).toContain('fresh reference');
    expect(ipcRenderer.invoke).not.toHaveBeenCalled();

    await card.setProps({ reference });
    vi.mocked(ipcRenderer.invoke).mockRejectedValueOnce(new Error('synthetic bridge unavailable'));
    await card.get('button[aria-label]').trigger('click');
    await flushPromises();
    expect(card.get('[role=alert]').text()).toContain('Try again');
    expect(card.text()).not.toContain('synthetic bridge unavailable');
    expect(ipcRenderer.invoke).toHaveBeenCalledOnce();
  });
});

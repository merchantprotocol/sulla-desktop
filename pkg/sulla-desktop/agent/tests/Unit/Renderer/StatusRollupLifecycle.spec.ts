// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createSSRApp, nextTick } from 'vue';
import { renderToString } from '@vue/server-renderer';

import StatusRollup from '@pkg/pages/chat/components/composer/StatusRollup.vue';
import type { StatusRollupItem } from '@pkg/pages/chat/components/composer/StatusRollupQueue';

const createItem = (): StatusRollupItem => ({
  key:        'check-in-1',
  threadId:   'thread-1',
  agentId:    'agent-1',
  agentName:  'Worker One',
  text:       'The worker is ready',
  observedAt: Date.now() - 1_000,
});

let mountedWrapper: VueWrapper | undefined;
const originalDocumentHidden = Object.getOwnPropertyDescriptor(document, 'hidden');

afterEach(() => {
  mountedWrapper?.unmount();
  mountedWrapper = undefined;
  if (originalDocumentHidden) Object.defineProperty(document, 'hidden', originalDocumentHidden);
  else Reflect.deleteProperty(document, 'hidden');
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('StatusRollup lifecycle', () => {
  // risk: core business rule — check-ins are only announced after the roll-up mounts.
  it('does not advance or announce a queued check-in during setup', async () => {
    const onShown = vi.fn();
    const checkIn = createItem();
    const app = createSSRApp(StatusRollup, {
      threadId: 'thread-1',
      checkIns: [checkIn],
      onShown,
    });

    const html = await renderToString(app);

    expect(html).not.toContain(checkIn.text);
    expect(onShown).not.toHaveBeenCalled();
  });

  // risk: resource leak — the mounted refresh interval must be released on teardown.
  it('starts its refresh interval after mount and clears it on unmount', async () => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    const setInterval = vi.spyOn(window, 'setInterval');
    const clearInterval = vi.spyOn(window, 'clearInterval');
    const checkIn = createItem();

    const wrapper = mount(StatusRollup, {
      attachTo: document.body,
      props: { threadId: 'thread-1', checkIns: [checkIn] },
    });
    mountedWrapper = wrapper;

    // onMounted emits synchronously, but its reactive DOM update is flushed on Vue's next tick.
    await nextTick();

    expect(wrapper.text()).toContain(checkIn.text);
    expect(wrapper.emitted('shown')).toEqual([[
      { key: checkIn.key, agentId: checkIn.agentId, threadId: checkIn.threadId },
    ]]);

    const intervalId = setInterval.mock.results[0]?.value;
    expect(intervalId).toBeDefined();

    wrapper.unmount();
    mountedWrapper = undefined;

    expect(clearInterval).toHaveBeenCalledWith(intervalId);
  });

  // risk: core business rule — hidden windows must not surface or announce queued check-ins.
  it('keeps a queued check-in paused until the document becomes visible', async () => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    const checkIn = createItem();
    const wrapper = mount(StatusRollup, {
      attachTo: document.body,
      props: { threadId: 'thread-1', checkIns: [checkIn] },
    });
    mountedWrapper = wrapper;

    await nextTick();

    expect(wrapper.text()).not.toContain(checkIn.text);
    expect(wrapper.emitted('shown')).toBeUndefined();

    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
    await nextTick();

    expect(wrapper.text()).toContain(checkIn.text);
    expect(wrapper.emitted('shown')).toEqual([[
      { key: checkIn.key, agentId: checkIn.agentId, threadId: checkIn.threadId },
    ]]);
  });
});

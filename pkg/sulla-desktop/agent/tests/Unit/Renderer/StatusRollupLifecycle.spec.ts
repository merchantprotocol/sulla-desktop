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
import { ComposerGlow } from '@pkg/pages/chat/components/composer/ComposerGlow';

const createItem = (key: string, threadId = 'thread-1', observedAt = Date.now() + 1): StatusRollupItem => ({
  key,
  threadId,
  agentId: `agent-${key}`,
  agentName: 'Worker',
  text: `Action ${key}`,
  observedAt,
});

let wrappers: VueWrapper[] = [];

afterEach(() => {
  wrappers.forEach(wrapper => wrapper.unmount());
  wrappers = [];
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('StatusRollup live lifecycle', () => {
  // risk: status replay — a long history already present at mount stays absent through SSR and hydration.
  it('does not render or announce check-ins that exist before the status subscription', async() => {
    vi.useFakeTimers();
    const historical = createItem('history', 'thread-1', Date.now() - 10_000);
    const onShown = vi.fn();
    const html = await renderToString(createSSRApp(StatusRollup, {
      threadId: 'thread-1', checkIns: [historical], onShown,
    }));
    expect(html).not.toContain(historical.text);

    const wrapper = mount(StatusRollup, {
      props: { threadId: 'thread-1', checkIns: [historical] },
    });
    wrappers.push(wrapper);
    await nextTick();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(wrapper.find('.status-rollup__line').exists()).toBe(false);
    expect(wrapper.text()).not.toContain(historical.text);
    expect(wrapper.emitted('shown')).toBeUndefined();
    expect(wrapper.emitted('consumer-attached')).toHaveLength(1);
  });

  // risk: action latency — a newly arriving event appears synchronously without waiting for a pump or interval.
  it('shows a live event immediately, within the 150 ms budget', async() => {
    vi.useFakeTimers();
    const wrapper = mount(StatusRollup, { props: { threadId: 'thread-1', checkIns: [] } });
    wrappers.push(wrapper);
    const before = Date.now();
    const live = createItem('live', 'thread-1', before + 1);

    await wrapper.setProps({ checkIns: [live] });

    expect(Date.now() - before).toBeLessThan(150);
    expect(wrapper.find('.status-rollup__line .status-rollup__text').text()).toBe(live.text);
    expect(wrapper.emitted('shown')).toEqual([[expect.objectContaining({ key: live.key, threadId: live.threadId })]]);
  });

  // risk: burst backlog replay — fifty rapid events leave only the newest visible after the burst and later dwell.
  it('keeps only the latest event from a 50-event burst and never cycles older items', async() => {
    vi.useFakeTimers();
    const wrapper = mount(StatusRollup, { props: { threadId: 'thread-1', checkIns: [] } });
    wrappers.push(wrapper);
    const start = Date.now();
    const events: StatusRollupItem[] = [];

    for (let index = 0; index < 50; index += 1) {
      events.push(createItem(`burst-${index}`, 'thread-1', start + index + 1));
      await wrapper.setProps({ checkIns: [...events] });
      await vi.advanceTimersByTimeAsync(20);
    }
    await nextTick();

    const lineText = (): string => wrapper.find('.status-rollup__line .status-rollup__text').text();
    expect(lineText()).toBe('Action burst-49');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(lineText()).toBe('Action burst-49');
    expect(wrapper.findAll('.status-rollup__line').length).toBe(1);
  });

  // risk: stale idle state — once the action loop quiets, the line clears and its one ghost is then forgotten.
  it('clears the current line after its dwell and removes the final ghost independently', async() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const wrapper = mount(StatusRollup, { props: { threadId: 'thread-1', checkIns: [] } });
    wrappers.push(wrapper);
    const live = createItem('idle', 'thread-1', Date.now() + 1);
    await wrapper.setProps({ checkIns: [live] });

    await vi.advanceTimersByTimeAsync(1_999);
    expect(wrapper.find('.status-rollup__line').exists()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(wrapper.find('.status-rollup__line').exists()).toBe(false);
    expect(wrapper.findAll('.status-rollup__ghost')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_500);
    await nextTick();
    expect(wrapper.find('.status-rollup').exists()).toBe(false);
  });

  // risk: stale-status revival — switching away/back or remounting cannot surface a status already shown.
  it('does not re-show a shown key after thread switching or a later mount', async() => {
    vi.useFakeTimers();
    const wrapper = mount(StatusRollup, { props: { threadId: 'thread-a', checkIns: [] } });
    wrappers.push(wrapper);
    const old = createItem('shown-a', 'thread-a', Date.now() + 1);
    await wrapper.setProps({ checkIns: [old] });
    expect(wrapper.text()).toContain(old.text);

    await wrapper.setProps({ threadId: 'thread-b', checkIns: [] });
    expect(wrapper.find('.status-rollup__line').exists()).toBe(false);
    await wrapper.setProps({ threadId: 'thread-a', checkIns: [old] });
    expect(wrapper.find('.status-rollup__line').exists()).toBe(false);

    wrapper.unmount();
    const remounted = mount(StatusRollup, { props: { threadId: 'thread-a', checkIns: [old] } });
    wrappers.push(remounted);
    await nextTick();
    expect(remounted.find('.status-rollup__line').exists()).toBe(false);
    expect(remounted.text()).not.toContain(old.text);
  });

  // risk: composer tool correlation — a late result finishes only its own earlier tool and reaches toolFinished once.
  it('delivers a late tool result once with its phase and correlation after a newer start', async() => {
    vi.useFakeTimers();
    const glow = new ComposerGlow();
    glow.setActive(true);
    const onShown = vi.fn((event: { phase?: string; correlationId?: string }) => {
      if (event.phase === 'start' && event.correlationId) glow.toolStarted(event.correlationId);
      if (event.phase === 'result' && event.correlationId) glow.toolFinished(event.correlationId);
    });
    const finished = vi.spyOn(glow, 'toolFinished');
    const wrapper = mount(StatusRollup, {
      props: { threadId: 'thread-1', checkIns: [], onShown },
    });
    wrappers.push(wrapper);

    const firstStart = { ...createItem('tool-a-start', 'thread-1', Date.now() + 1), kind: 'tool' as const,
      phase: 'start' as const, correlationId: 'tool-a' };
    await wrapper.setProps({ checkIns: [firstStart] });
    await vi.advanceTimersByTimeAsync(2_000);
    const newerStart = { ...createItem('tool-b-start', 'thread-1', Date.now() + 1), kind: 'tool' as const,
      phase: 'start' as const, correlationId: 'tool-b' };
    await wrapper.setProps({ checkIns: [firstStart, newerStart] });
    await vi.advanceTimersByTimeAsync(1_000);

    const lateResult = { ...createItem('tool-a-result', 'thread-1', Date.now() + 1), kind: 'tool' as const,
      phase: 'result' as const, correlationId: 'tool-a' };
    await wrapper.setProps({ checkIns: [firstStart, newerStart, lateResult] });
    await wrapper.setProps({ checkIns: [firstStart, newerStart, lateResult, { ...lateResult }] });

    expect(finished).toHaveBeenCalledTimes(1);
    expect(finished).toHaveBeenCalledWith('tool-a');
    expect(wrapper.emitted('shown')).toEqual([
      [expect.objectContaining({ key: 'tool-a-start', phase: 'start', correlationId: 'tool-a' })],
      [expect.objectContaining({ key: 'tool-b-start', phase: 'start', correlationId: 'tool-b' })],
      [expect.objectContaining({ key: 'tool-a-result', phase: 'result', correlationId: 'tool-a' })],
    ]);
    expect(glow.state.deep).toBe(false);
    glow.dispose();
  });

  // risk: component lifecycle leaks — unmount detaches its consumer, media listener and every dwell/ghost timer.
  it('detaches and clears all owned timers and its matchMedia listener on unmount', async() => {
    vi.useFakeTimers();
    const descriptor = Object.getOwnPropertyDescriptor(window, 'matchMedia');
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    const mediaQuery = { matches: false, addEventListener, removeEventListener } as unknown as MediaQueryList;
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => mediaQuery) });

    try {
      const wrapper = mount(StatusRollup, { props: { threadId: 'thread-1', checkIns: [] } });
      wrappers.push(wrapper);
      await nextTick();
      const first = createItem('first', 'thread-1', Date.now() + 1);
      await wrapper.setProps({ checkIns: [first] });
      const second = createItem('second', 'thread-1', Date.now() + 2);
      await wrapper.setProps({ checkIns: [first, second] });
      expect(wrapper.findAll('.status-rollup__ghost')).toHaveLength(1);
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      wrapper.unmount();
      wrappers = wrappers.filter(candidate => candidate !== wrapper);

      expect(wrapper.emitted('consumer-detached')).toHaveLength(1);
      expect(addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
      expect(removeEventListener).toHaveBeenCalledWith('change', addEventListener.mock.calls[0]?.[1]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      if (descriptor) Object.defineProperty(window, 'matchMedia', descriptor);
      else delete (window as Partial<Window>).matchMedia;
    }
  });
});

// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
// "Sulla" is a trademark. See TRADEMARK.md.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { computed, nextTick, ref } from 'vue';

import WorkerChart from '../../../../pages/chat/components/workerChart/WorkerChart.vue';
import { WorkerChartController } from '../../../../pages/chat/components/workerChart/WorkerChartController';
import { WorkerChartOverlayController } from '../../../../pages/chat/components/workerChart/WorkerChartOverlayController';
import { WorkerChartTimeFormatter } from '../../../../pages/chat/components/workerChart/WorkerChartTimeFormatter';
import { WorkerChartActivityBuckets, WorkerChartGeometry, WorkerChartLayout } from '../../../../pages/chat/components/workerChart/workerChartModel';
import type { WorkerChartAgent } from '../../../../pages/chat/components/workerChart/workerChartModel';

const fixedNow = 1_700_000_000_000;
const wrappers: VueWrapper[] = [];
const originalDocumentHidden = Object.getOwnPropertyDescriptor(document, 'hidden');
const originalGetAnimations = Object.getOwnPropertyDescriptor(document, 'getAnimations');

function sampleTree(): WorkerChartAgent {
  return {
    id: 'root',
    name: 'Sulla',
    initials: 'S',
    state: 'working',
    children: [{
      id: 'worker-1',
      name: 'Review worker',
      initials: 'RW',
      lane: 'Code review',
      state: 'working',
      model: 'codex-gpt-6.2-sol',
      task: 'Verify the live agent tree and preserve its real check-in metadata',
      startedAt: fixedNow - 83_000,
      lastCheckIn: { timestamp: fixedNow - 1_500, text: 'Reviewed the ownership boundary' },
      activity: [
        { timestamp: fixedNow - 149_000, value: 1 },
        { timestamp: fixedNow - 50_000, value: 3 },
        { timestamp: fixedNow - 500, value: 2 },
      ],
    }],
  };
}

function mountChart(root: WorkerChartAgent = sampleTree(), chatColumnWidth = 1_000, snippetTick?: { agentId: string; sequence: number }): VueWrapper {
  const wrapper = mount(WorkerChart, { props: { root, chatColumnWidth, snippetTick }, attachTo: document.body });
  wrappers.push(wrapper);
  return wrapper;
}

function createController(root: WorkerChartAgent): { controller: WorkerChartController; setRoot: (value: WorkerChartAgent) => void } {
  const rootValue = ref<WorkerChartAgent | null>(root);
  const sources = {
    root: computed(() => rootValue.value),
    chatColumnWidth: computed(() => 1_000),
    snippetTick: computed(() => null),
    instanceId: 'controller-test',
    openAgent: vi.fn(),
  };
  const interaction = new WorkerChartOverlayController(sources);
  const controller = new WorkerChartController(sources, new WorkerChartLayout(), new WorkerChartGeometry(),
    new WorkerChartActivityBuckets(), new WorkerChartTimeFormatter(), interaction);
  return { controller, setRoot: value => { rootValue.value = value } };
}

afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount());
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (originalDocumentHidden) Object.defineProperty(document, 'hidden', originalDocumentHidden);
  else Reflect.deleteProperty(document, 'hidden');
  if (originalGetAnimations) Object.defineProperty(document, 'getAnimations', originalGetAnimations);
  else Reflect.deleteProperty(document, 'getAnimations');
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(fixedNow);
});

describe('WorkerChart', () => {
  it('shows the selected agent’s live metadata and emits its id from Open', async () => {
    // risk: misleading agent activity — the popover and Open action must retain the selected real job identity
    const wrapper = mountChart();
    await wrapper.get('[data-agent-id="worker-1"]').trigger('click');
    await nextTick();

    const popover = document.body.querySelector('.worker-chart__popover');
    expect(popover?.getAttribute('role')).toBe('dialog');
    expect(popover?.textContent).toContain('codex-gpt-6.2-sol');
    expect(popover?.textContent).toContain('Verify the live agent tree');
    expect(popover?.textContent).toContain('Reviewed the ownership boundary');

    document.body.querySelector<HTMLButtonElement>('.worker-chart__open')?.click();
    expect(wrapper.emitted('open-agent')).toEqual([[{ agentId: 'worker-1' }]]);
  });

  it('closes on Escape without a tooltip, preserves intentional focus feedback, and keeps removed-node fallback quiet', async () => {
    // risk: keyboard access — closing a popover must not strand focus on a removed element
    const wrapper = mountChart();
    const trigger = wrapper.get('[data-agent-id="worker-1"]');
    await trigger.trigger('click');
    await nextTick();
    expect(document.activeElement).toBe(document.body.querySelector('.worker-chart__popover'));

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await nextTick();
    expect(document.activeElement).toBe(trigger.element);
    expect(document.body.querySelector('.worker-chart__popover[role="dialog"]')).toBeNull();
    expect(document.body.querySelector('.worker-chart__popover[role="tooltip"]')).toBeNull();

    await trigger.trigger('focus');
    await nextTick();
    expect(document.body.querySelector('.worker-chart__popover[role="tooltip"]')).not.toBeNull();

    await trigger.trigger('click');
    await nextTick();
    await wrapper.setProps({ root: { ...sampleTree(), children: [] } });
    await nextTick();
    await nextTick();
    expect(document.body.querySelector('.worker-chart__popover[role="dialog"]')).toBeNull();
    expect(document.body.querySelector('.worker-chart__popover[role="tooltip"]')).toBeNull();
    expect((document.activeElement as HTMLElement).dataset.agentId).toBe('root');
  });

  it('closes on an outside pointer without pulling focus away from the outside target', async () => {
    // risk: keyboard and pointer access — outside dismissal must close the dialog without stealing focus
    const wrapper = mountChart();
    await wrapper.get('[data-agent-id="worker-1"]').trigger('click');
    await nextTick();
    expect(document.body.querySelector('.worker-chart__popover[role="dialog"]')).not.toBeNull();

    const outsideButton = document.createElement('button');
    document.body.appendChild(outsideButton);
    outsideButton.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    outsideButton.focus();
    await nextTick();

    expect(document.body.querySelector('.worker-chart__popover[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(outsideButton);
    expect(document.body.querySelector('.worker-chart__popover[role="tooltip"]')).toBeNull();
  });

  it('opens the compact rail as a full interactive overlay when the measured chat column is narrow', async () => {
    // risk: narrow chat usability — the chart must remain reachable without reserving chat width
    const wrapper = mountChart(sampleTree(), 899);
    await wrapper.get('[aria-label="Open worker chart"]').trigger('click');
    await nextTick();

    const overlay = document.body.querySelector('[role="dialog"][aria-label="Worker chart"]');
    expect(overlay).not.toBeNull();
    expect(overlay?.querySelector('[data-agent-id="worker-1"]')).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await nextTick();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await nextTick();
    expect(document.body.querySelector('[role="dialog"][aria-label="Worker chart"]')).toBeNull();
  });

  it('renders every agent in a wide fan-out and keeps a finished agent until the linger delay ends', async () => {
    // risk: agent visibility — every child needs its own row; completed rows retain their existing linger window
    const children: WorkerChartAgent[] = ['a', 'b', 'c', 'd', 'e', 'f'].map((id): WorkerChartAgent => ({
      id: `worker-${id}`, name: `Worker ${id}`, initials: id.toUpperCase(), state: id === 'f' ? 'done' : 'working',
    }));
    const wrapper = mountChart({ id: 'root', name: 'Sulla', initials: 'S', state: 'working', children });
    await nextTick();

    const ids = () => wrapper.findAll('[data-agent-id]').map(node => node.attributes('data-agent-id'));
    expect(ids()).toEqual(['root', 'worker-a', 'worker-b', 'worker-c', 'worker-d', 'worker-e', 'worker-f']);
    expect(wrapper.findAll('.worker-chart__row')).toHaveLength(7);
    expect(wrapper.find('.worker-chart__node--group').exists()).toBe(false);
    expect(wrapper.get('[data-agent-id="worker-f"]').attributes('data-state')).toBe('done');

    vi.advanceTimersByTime(9_999);
    await nextTick();
    expect(ids()).toContain('worker-f');

    vi.advanceTimersByTime(1);
    await nextTick();
    expect(ids()).toEqual(['root', 'worker-a', 'worker-b', 'worker-c', 'worker-d', 'worker-e']);
  });

  it('animates the marker belonging to the agent that reported a snippet tick', async () => {
    // risk: missed live feedback — each agent tick must animate that agent’s own marker.
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const children: WorkerChartAgent[] = ['a', 'b', 'c', 'd', 'e', 'f'].map(id => ({
      id: `worker-${id}`, name: `Worker ${id}`, initials: id.toUpperCase(), state: 'working',
    }));
    const wrapper = mountChart({ id: 'root', name: 'Sulla', initials: 'S', state: 'working', children });
    const agentMarker = wrapper.get('[data-agent-id="worker-e"] .worker-chart__marker').element;
    const animation = { onfinish: null, cancel: vi.fn(), pause: vi.fn(), play: vi.fn(), playState: 'running' } as unknown as Animation;
    const animate = vi.fn(() => animation);
    Object.defineProperty(agentMarker, 'animate', { configurable: true, value: animate });

    await wrapper.setProps({ snippetTick: { agentId: 'worker-e', sequence: 1 } });
    await nextTick();
    await nextTick();

    expect(animate).toHaveBeenCalledWith(
      [{ transform: 'scale(1)' }, { transform: 'scale(1.28)' }, { transform: 'scale(1)' }],
      expect.objectContaining({ duration: 320 }),
    );
  });

  it('pauses and resumes active Web Animations while the document is hidden', () => {
    // risk: visibility and battery use — chart motion must pause while its chat tab is hidden and resume afterward.
    let playState: AnimationPlayState = 'running';
    const pause = vi.fn(() => { playState = 'paused'; });
    const play = vi.fn(() => { playState = 'running'; });
    const animation = { get playState() { return playState; }, pause, play } as unknown as Animation;
    Object.defineProperty(document, 'getAnimations', { configurable: true, value: () => [animation] });
    const wrapper = mountChart();
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(pause).toHaveBeenCalledOnce();

    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(play).toHaveBeenCalledOnce();
    wrapper.unmount();
  });

  it('moves a departing child row toward its actual parent', async () => {
    // risk: animation geometry — source updates must not detach a departing child from its parent.
    const children: WorkerChartAgent[] = [
      { id: 'worker-a', name: 'Worker A', initials: 'A', state: 'working' },
      { id: 'worker-b', name: 'Worker B', initials: 'B', state: 'working' },
    ];
    const root: WorkerChartAgent = { id: 'root', name: 'Sulla', initials: 'S', state: 'working', children };
    const fixture = createController(root);
    try {
      const departing = fixture.controller.chart.rows.find(row => row.agent.id === 'worker-a');
      if (!departing) throw new Error('Departing child is missing.');
      fixture.setRoot({ ...root, children: [children[1]] });
      await nextTick();
      await nextTick();
      const element = document.createElement('li');
      element.dataset.rowKey = departing.key;
      element.dataset.parentId = departing.parentId ?? '';
      fixture.controller.beforeRowLeave(element);

      const parent = fixture.controller.chart.rows.find(row => row.agent.id === 'root');
      expect(element.style.getPropertyValue('--worker-chart-leave-x')).toBe(`${(parent?.x ?? 0) + 14 - departing.x}px`);
      expect(element.style.getPropertyValue('--worker-chart-leave-y')).toBe(`${(parent?.y ?? 0) - departing.y}px`);
    } finally {
      fixture.controller.unmount();
    }
  });
});

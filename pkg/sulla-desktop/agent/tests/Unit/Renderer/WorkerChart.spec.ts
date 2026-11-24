// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
// "Sulla" is a trademark. See TRADEMARK.md.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';

import WorkerChart from '../../../../pages/chat/components/workerChart/WorkerChart.vue';
import type { WorkerChartAgent } from '../../../../pages/chat/components/workerChart/workerChartModel';

const fixedNow = 1_700_000_000_000;
const wrappers: VueWrapper[] = [];

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

function mountChart(root: WorkerChartAgent = sampleTree(), chatColumnWidth = 1_000): VueWrapper {
  const wrapper = mount(WorkerChart, { props: { root, chatColumnWidth }, attachTo: document.body });
  wrappers.push(wrapper);
  return wrapper;
}

afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount());
  document.body.innerHTML = '';
  vi.useRealTimers();
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
    expect(popover?.querySelector('svg[role="img"]')?.getAttribute('aria-label')).toContain('3 samples');

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
});

// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';

import WorkerChart from '../../../../pages/chat/components/workerChart/WorkerChart.vue';
import type { WorkerChartAgent } from '../../../../pages/chat/components/workerChart/workerChartModel';

const workerChartCssPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../pages/chat/components/workerChart/workerChart.css');
const workerChartCss = readFileSync(workerChartCssPath, 'utf8');
const appButtonDefaults = `
  :root { --outline-width: 1px; }
  button { display: inline-block; padding: 0 21px; border-radius: 4px; color: #fff; line-height: 40px; min-height: 40px; }
  button { margin: var(--outline-width); }
`;

let wrapper: VueWrapper | null = null;
let stylesheet: HTMLStyleElement | null = null;

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  stylesheet?.remove();
  stylesheet = null;
  document.body.innerHTML = '';
  document.documentElement.classList.remove('dark');
});

describe('WorkerChartPopover', () => {
  it('keeps the teleported Open button at the approved size with its palette available in both themes', async () => {
    // risk: chart usability and contrast — global button defaults must not enlarge or offset Open outside its chart root.
    stylesheet = document.createElement('style');
    stylesheet.textContent = `${appButtonDefaults}\n${workerChartCss}`;
    document.head.appendChild(stylesheet);

    const root: WorkerChartAgent = {
      id: 'root', name: 'Sulla', initials: 'S', state: 'working',
      children: [{ id: 'worker-1', name: 'Review worker', initials: 'RW', state: 'working' }],
    };
    wrapper = mount(WorkerChart, { props: { root, chatColumnWidth: 1_000 }, attachTo: document.body });
    await wrapper.get('[data-agent-id="worker-1"]').trigger('click');
    await nextTick();

    const popover = document.body.querySelector<HTMLElement>('.worker-chart__popover');
    const openButton = popover?.querySelector<HTMLButtonElement>('.worker-chart__open');
    expect(popover?.parentElement).toBe(document.body);
    expect(getComputedStyle(popover!).getPropertyValue('--mk-ac')).not.toBe('');
    expect(getComputedStyle(popover!).getPropertyValue('--mk-on-ac')).toBe('#fff');
    expect(openButton).not.toBeNull();
    expect(getComputedStyle(openButton!).height).toBe('32px');
    expect(Number.parseFloat(getComputedStyle(openButton!).minHeight)).toBe(0);
    expect(Number.parseFloat(getComputedStyle(openButton!).margin)).toBe(0);

    document.documentElement.classList.add('dark');
    expect(getComputedStyle(popover!).getPropertyValue('--mk-on-ac')).toBe('#0d1114');
  });
});

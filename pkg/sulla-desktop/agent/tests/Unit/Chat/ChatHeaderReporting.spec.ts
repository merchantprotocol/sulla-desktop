// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
// @vitest-environment jsdom

import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';

import ChatHeader from '@pkg/pages/chat/components/chrome/ChatHeader.vue';
import { ChatControllerKey } from '@pkg/pages/chat/controller/useChatController';
import type { ReportingLevel } from '@pkg/pages/chat/models/ReportingLevel';

const reportingModes: Array<{ value: ReportingLevel; label: string }> = [
  { value: 'fatal', label: 'Brief' },
  { value: 'info', label: 'Standard' },
  { value: 'debug', label: 'Detailed' },
];

function mountHeader(reportingLevel: ReportingLevel | string = 'info') {
  const controller = {
    thread: ref({ title: 'Reporting test' }),
    sidebar: ref({ historyOpen: false }),
    toggleHistory: vi.fn(),
    renameThread: vi.fn(),
  };
  const header = mount(ChatHeader, {
    props: { reportingLevel: reportingLevel as ReportingLevel },
    global: { provide: { [ChatControllerKey as symbol]: controller } },
  });

  return { header, controller };
}

function radioFor(header: ReturnType<typeof mountHeader>['header'], level: ReportingLevel) {
  return header.find(`[data-reporting-level="${level}"]`);
}

async function pressRadioKey(header: ReturnType<typeof mountHeader>['header'], level: ReportingLevel, key: string): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  radioFor(header, level).element.dispatchEvent(event);
  await nextTick();
  await nextTick();
  return event;
}

describe('ChatHeader reporting modes', () => {
  // risk: core business rule — each visible reporting mode must keep its established ReportingLevel value.
  it.each(reportingModes)('maps $label to $value and emits one update on selection', async({ value, label }) => {
    const { header } = mountHeader('info');
    const radio = radioFor(header, value);

    expect(header.get('[role="radiogroup"]').attributes('aria-label')).toBe('Reporting');
    expect(radio.attributes('role')).toBe('radio');
    expect(radio.attributes('aria-label')).toBe(label);
    expect(radio.attributes('title')).toBe(label);
    expect(radio.attributes('type')).toBe('button');

    await radio.trigger('click');

    expect(header.emitted('update:reportingLevel')).toEqual([[value]]);
  });

  // risk: core business rule — the selected value is the only tab stop, with Standard as a safe invalid-value fallback.
  it.each([
    ['fatal', 'fatal'],
    ['info', 'info'],
    ['debug', 'debug'],
    ['unknown', 'info'],
  ])('keeps one checked roving tab stop for %s', (modelValue, activeValue) => {
    const { header } = mountHeader(modelValue);
    const checked = header.findAll('[role="radio"][aria-checked="true"]');
    const tabStops = header.findAll('[role="radio"][tabindex="0"]');

    expect(checked).toHaveLength(1);
    expect(tabStops).toHaveLength(1);
    expect(checked[0].attributes('data-reporting-level')).toBe(activeValue);
    expect(tabStops[0].attributes('data-reporting-level')).toBe(activeValue);
  });

  // risk: keyboard users need wrapped navigation to select the same model value as pointer users and retain focus.
  it('wraps arrow-key navigation and moves focus after selection', async() => {
    const { header } = mountHeader('fatal');

    const left = await pressRadioKey(header, 'fatal', 'ArrowLeft');
    expect(left.defaultPrevented).toBe(true);
    expect(header.emitted('update:reportingLevel')?.slice(-1)[0]).toEqual(['debug']);
    expect(document.activeElement).toBe(radioFor(header, 'debug').element);
    await header.setProps({ reportingLevel: 'debug' });

    const right = await pressRadioKey(header, 'debug', 'ArrowRight');
    expect(right.defaultPrevented).toBe(true);
    expect(header.emitted('update:reportingLevel')?.slice(-1)[0]).toEqual(['fatal']);
    expect(document.activeElement).toBe(radioFor(header, 'fatal').element);
  });

  // risk: keyboard users must be able to jump to the first or last setting without page scrolling.
  it('uses Home and End to select and focus the first and last modes', async() => {
    const { header } = mountHeader('info');

    const home = await pressRadioKey(header, 'info', 'Home');
    expect(home.defaultPrevented).toBe(true);
    expect(header.emitted('update:reportingLevel')?.slice(-1)[0]).toEqual(['fatal']);
    expect(document.activeElement).toBe(radioFor(header, 'fatal').element);
    await header.setProps({ reportingLevel: 'fatal' });

    const end = await pressRadioKey(header, 'fatal', 'End');
    expect(end.defaultPrevented).toBe(true);
    expect(header.emitted('update:reportingLevel')?.slice(-1)[0]).toEqual(['debug']);
    expect(document.activeElement).toBe(radioFor(header, 'debug').element);
  });

  // risk: native Space/Enter button activation must not emit an extra update from custom keyboard handling.
  it.each([' ', 'Enter'])('does not emit on the %s keydown path; one native click emits once', async(key) => {
    const { header } = mountHeader('info');
    const brief = radioFor(header, 'fatal');

    await brief.trigger('keydown', { key });
    expect(header.emitted('update:reportingLevel')).toBeUndefined();

    brief.element.click();
    expect(header.emitted('update:reportingLevel')).toEqual([['fatal']]);
  });
});

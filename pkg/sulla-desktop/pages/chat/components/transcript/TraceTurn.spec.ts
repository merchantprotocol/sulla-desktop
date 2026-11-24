// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import TraceTurn from './TraceTurn.vue';
import type { DetailedTraceTurn } from './DetailedTraceProjection';

describe('Detailed trace rendering', () => {
  it('renders hostile metadata and expanded payloads as inert text with a keyboard-native disclosure', async() => {
    // risk: DOM injection — all interpolated fields and object keys must remain text, never executable markup.
    const script = '<script>window.traceXss = 1</script>';
    const image = '<img src=x onerror="window.traceXss = 2">';
    const svg = '<svg onload="window.traceXss = 3"></svg>';
    const turn: DetailedTraceTurn = {
      id: 'trace:user-1', afterId: 'user-1',
      metadata: { agent: script, model: image, steps: 1 },
      rows: [{
        id: 'tool-row', sourceId: 'tool-row', kind: 'tool', verb: script, toolName: svg, target: image, args: svg,
        note: image, status: 'ok', rawPayload: { [svg]: script, args: image, api_token: 'fixture-restored-secret', passwd: 1234, max_tokens: 32 },
      }],
    };
    const wrapper = mount(TraceTurn, { props: { turn } });

    expect(wrapper.findAll('script, img, svg')).toHaveLength(0);
    expect(wrapper.text()).toContain(script);
    expect(wrapper.text()).toContain(image);
    expect(wrapper.text()).toContain(svg);

    const button = wrapper.get('button.trace-row__expand');
    expect(button.element.tagName).toBe('BUTTON');
    expect(button.attributes('type')).toBe('button');
    expect(button.element.tabIndex).toBe(0);
    expect(button.attributes('aria-expanded')).toBe('false');
    const payload = wrapper.get('pre.trace-row__payload');
    expect(button.attributes('aria-controls')).toBe(payload.attributes('id'));
    expect(payload.element.hidden).toBe(true);

    await button.trigger('click');
    expect(button.attributes('aria-expanded')).toBe('true');
    expect(payload.text()).toContain(script);
    expect(payload.text()).toContain(svg);
    expect(payload.text()).not.toContain('fixture-restored-secret');
    expect(payload.text()).not.toContain('1234');
    expect(payload.text()).toContain('"max_tokens": 32');
    expect(wrapper.findAll('script, img, svg')).toHaveLength(0);
  });

  it('serializes only on expansion and preserves open state across a streamed payload replacement', async() => {
    // risk: long-running turns — streamed placeholder updates must not close an open disclosure.
    const initial: DetailedTraceTurn = {
      id: 'trace:user-2', afterId: 'user-2', metadata: { steps: 1 },
      rows: [{ id: 'stable-row', sourceId: 'stable-row', kind: 'tool', verb: 'Ran', target: 'check', status: 'running', rawPayload: { output: 'partial' } }],
    };
    const wrapper = mount(TraceTurn, { props: { turn: initial } });
    const button = wrapper.get('button.trace-row__expand');
    const payload = wrapper.get('pre.trace-row__payload');
    expect(payload.text()).toBe('');

    await button.trigger('click');
    expect(payload.text()).toContain('partial');

    const replacement: DetailedTraceTurn = {
      ...initial,
      rows: [{ ...initial.rows[0], status: 'ok', rawPayload: { output: 'settled' } }],
    };
    await wrapper.setProps({ turn: replacement });
    expect(button.attributes('aria-expanded')).toBe('true');
    expect(payload.text()).toContain('settled');
    expect(payload.text()).not.toContain('partial');
  });
});

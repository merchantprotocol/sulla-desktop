// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

import ComposerInput from '@pkg/pages/chat/components/composer/ComposerInput.vue';
import ComposerSend from '@pkg/pages/chat/components/composer/ComposerSend.vue';
import { activateComposerSend, composerSendState } from '@pkg/pages/chat/components/composer/ComposerSendBehavior';
import RunControls from '@pkg/pages/chat/components/composer/RunControls.vue';
import { ChatControllerKey } from '@pkg/pages/chat/controller/useChatController';

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn((channel: string) => Promise.resolve(channel === 'agents:thread-live-children' ? { count: 0 } : { ok: true, killedJobs: 0 })),
}));
vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: { invoke } }));

const mounted: { unmount(): void }[] = [];
afterEach(() => {
  mounted.splice(0).forEach(wrapper => wrapper.unmount());
  invoke.mockClear();
});

describe('composer queue and stop controls', () => {
  it('keeps the running primary action dedicated to queueing', async() => {
    const wrapper = mount(ComposerSend, { props: { running: true, canSend: true } });
    mounted.push(wrapper);

    const button = wrapper.get('button');
    expect(button.attributes('aria-label')).toBe('Queue message');
    expect(button.text()).toContain('Queue');
    expect(button.attributes('disabled')).toBeUndefined();

    await button.trigger('click');
    expect(wrapper.emitted('send')).toHaveLength(1);
  });

  it('shows a disabled Queue action for an empty running draft', () => {
    const wrapper = mount(ComposerSend, { props: { running: true, canSend: false } });
    mounted.push(wrapper);

    const button = wrapper.get('button');
    expect(button.attributes('aria-label')).toBe('Queue message');
    expect(button.attributes('disabled')).toBeDefined();
    expect(button.find('.stop-square').exists()).toBe(false);
  });

  it('retains normal Send behavior when idle', async() => {
    const wrapper = mount(ComposerSend, { props: { running: false, canSend: true } });
    mounted.push(wrapper);

    const button = wrapper.get('button');
    expect(button.attributes('aria-label')).toBe('Send message');
    await button.trigger('click');
    expect(wrapper.emitted('send')).toHaveLength(1);
  });

  it('never maps the queue action to controller stop', () => {
    const send = vi.fn();
    activateComposerSend(true, send);
    expect(send).toHaveBeenCalledOnce();
    expect(composerSendState(true, true)).toBe('queue');
    expect(composerSendState(false, true)).toBe('ready');
  });

  it('keeps the textarea enabled and emits Enter exactly once while queueing', async() => {
    const wrapper = mount(ComposerInput, { props: { modelValue: 'queued follow-up' } });
    mounted.push(wrapper);

    const textarea = wrapper.get('textarea');
    expect(textarea.attributes('disabled')).toBeUndefined();

    await textarea.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('send')).toEqual([['queued follow-up']]);
  });

  it('renders Stop as a separate running control', async() => {
    const stop = vi.fn();
    const wrapper = mount(RunControls, {
      global: {
        provide: {
          [ChatControllerKey as symbol]: {
            isRunning:   ref(true),
            runState:    ref({ phase: 'thinking', startedAt: 1, messageId: 'message-1' }),
            thread:      ref({ id: 'thread-1', backendThreadId: 'backend-thread-1' }),
            stop,
            continueRun: vi.fn(),
          },
        },
      },
    });
    mounted.push(wrapper);

    const button = wrapper.get('button[aria-label="Stop Sulla"]');
    expect(button.text()).toContain('Stop');
    await button.trigger('click');
    expect(stop).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith('agents:thread-live-children', 'backend-thread-1');
  });

  it('keeps the live sub-agent prompt visible after the parent stops', async() => {
    const isRunning = ref(true);
    const stop = vi.fn(() => { isRunning.value = false });
    invoke.mockResolvedValueOnce({ count: 2 });
    const wrapper = mount(RunControls, {
      global: {
        provide: {
          [ChatControllerKey as symbol]: {
            isRunning,
            runState:    ref({ phase: 'thinking', startedAt: 1, messageId: 'message-1' }),
            thread:      ref({ id: 'thread-1', backendThreadId: 'backend-thread-1' }),
            stop,
            continueRun: vi.fn(),
          },
        },
      },
    });
    mounted.push(wrapper);

    await wrapper.get('button[aria-label="Stop Sulla"]').trigger('click');
    await flushPromises();

    expect(isRunning.value).toBe(false);
    expect(wrapper.get('.child-stop-popover').text()).toContain('2 sub-agents still running');
    expect(wrapper.get('.child-stop-popover').text()).toContain('Kill all');
  });
});

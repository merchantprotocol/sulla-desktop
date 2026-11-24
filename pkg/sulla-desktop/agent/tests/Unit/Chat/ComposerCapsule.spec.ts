// @vitest-environment jsdom
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ref } from 'vue';

const fixture = vi.hoisted(() => ({
  ipc: {
    invoke: vi.fn(async(channel: string) => channel === 'files-ui:recent-references' ? [] : null),
    on: vi.fn(),
    removeListener: vi.fn(),
    send: vi.fn(),
  },
  remoteSessions: [] as any[],
  voiceAdapters: [] as any[],
  useCases: null as any,
}));

vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: fixture.ipc }));
vi.mock('@pkg/composables/useBrowserTabs', () => ({ useBrowserTabs: () => ({ createTab: vi.fn(() => ({ id: 'fixture-tab' })) }) }));
vi.mock('@pkg/agent/database/models/SullaSettingsModel', () => ({ SullaSettingsModel: { get: vi.fn(async(_key: string, fallback: unknown) => fallback), set: vi.fn() } }));
vi.mock('@pkg/pages/chat/composables/useArtifactMentions', () => ({ useArtifactMentions: () => ({ prefetch: vi.fn(), list: vi.fn(async() => []) }) }));
vi.mock('@pkg/pages/chat/composables/useCommandPopover', () => ({ useCommandPopover: vi.fn() }));
vi.mock('@pkg/pages/chat/composables/useDockPosition', async() => {
  const { ref } = await import('vue');
  return { DockPositions: { use: () => ({ position: ref('bottom'), setPosition: vi.fn() }) } };
});
vi.mock('@pkg/pages/chat/composables/useSelectionLabel', async() => {
  const { computed } = await import('vue');
  return { useSelectionLabel: () => ({ label: computed(() => 'Fixture model'), title: computed(() => 'Fixture model') }) };
});
vi.mock('@pkg/pages/chat/composables/useUseCaseSuggestions', async() => {
  const { reactive, ref } = await import('vue');
  return {
    useUseCaseSuggestions: () => {
      const state = {
        intent: ref(null),
        open: ref(false),
        strip: reactive({ items: [], active: -1, latencyMs: 0 }),
        directive: {
          compose: (_intent: unknown, text: string) => text,
          label: (intent: any) => ({ verb: 'Use', title: intent.item.title }),
          metadata: () => ({}),
          routeAgentId: () => undefined,
        },
        onKeydown: vi.fn(() => false),
        pick: vi.fn(),
        reset: vi.fn(),
        dismiss: vi.fn(),
        removeIntent: vi.fn(),
      };
      fixture.useCases = state;
      return state;
    },
  };
});
vi.mock('@pkg/pages/chat/services/VoiceSessionAdapter', async() => {
  class VoiceSessionAdapter {
    constructor() { fixture.voiceAdapters.push(this); }
    toggle = vi.fn();
    stop = vi.fn();
    dispose = vi.fn();
    handleDeactivated = vi.fn();
  }
  return { VoiceSessionAdapter };
});
vi.mock('@pkg/pages/chat/services/RemoteChatSession', async() => {
  const { ref } = await import('vue');
  class RemoteChatSession {
    constructor() {
      const device = { id: 'fixture-device', name: 'Fixture device', online: true, models: [{ providerId: 'openai', modelId: 'gpt-4o-mini' }] };
      this.remote = ref(false);
      this.available = ref(true);
      this.running = ref(false);
      this.bound = ref(undefined);
      this.selected = ref(undefined);
      this.chosen = ref(false);
      this.models = ref(device.models);
      this.model = ref(undefined);
      this.pickerDevices = ref([device]);
      this.status = ref('Disconnected');
      this.note = ref('');
      this.select = vi.fn(selected => { this.selected.value = selected; this.chosen.value = true; });
      this.sendDraft = vi.fn();
      this.canSend = vi.fn(() => true);
      this.refresh = vi.fn();
      this.mount = vi.fn();
      this.dispose = vi.fn();
      fixture.remoteSessions.push(this);
    }
  }
  return { RemoteChatSession };
});
vi.mock('@pkg/composables/useFocusGuard', () => ({ useFocusGuard: vi.fn() }));

import { AGENT_STATE_CLIENT_KEY } from '@pkg/services/agentState/AgentStateInjection';
import { ChatController } from '@pkg/pages/chat/controller/ChatController';
import { ChatControllerKey } from '@pkg/pages/chat/controller/useChatController';
import Composer from '@pkg/pages/chat/components/composer/Composer.vue';

describe('Capsule chat composer', () => {
  let controller: ChatController;
  let wrapper: VueWrapper | undefined;
  let focus: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    fixture.ipc.invoke.mockClear();
    fixture.ipc.invoke.mockImplementation(async(channel: string) => channel === 'files-ui:recent-references' ? [] : null);
    fixture.remoteSessions.length = 0;
    fixture.voiceAdapters.length = 0;
    fixture.useCases = null;
    focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    controller = new ChatController();
    wrapper = mount(Composer, {
      props: { reportingLevel: 'debug' },
      global: {
        provide: {
          [ChatControllerKey as symbol]: controller,
          [AGENT_STATE_CLIENT_KEY as symbol]: { snapshot: ref({ rows: [] }) },
          'chat:activity-context': { backendThreadId: ref(undefined) },
          'chat:is-active': ref(true),
        },
        stubs: {
          CommandPopover: { template: '<div class="command-popover-stub" />' },
          ShelfPanel: true,
          ThreadStatusLine: { template: '<div class="thread-status-stub"><slot name="end" /></div>' },
          ComposerVoicePanel: true,
        },
      },
    });
  });

  afterEach(() => {
    wrapper?.unmount();
    controller?.dispose();
    focus?.mockRestore();
    wrapper = undefined;
  });

  function capsule(): VueWrapper {
    if (!wrapper) throw new Error('Composer fixture is not mounted.');
    return wrapper;
  }

  function textarea(): HTMLTextAreaElement {
    return capsule().get('textarea.input').element as HTMLTextAreaElement;
  }

  function keydown(init: KeyboardEventInit, keyCode?: number): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    if (keyCode !== undefined) Object.defineProperty(event, 'keyCode', { get: () => keyCode });
    textarea().dispatchEvent(event);
    return event;
  }

  it('tracks local and remote run state and marks the halo inactive while the host is hidden', async() => {
    // risk: availability — a busy thread must keep the Capsule run indicator active independent of event frequency.
    controller.send('Start a local fixture run.');
    await flushPromises();
    expect(capsule().get('.composer-capsule').classes()).toContain('is-running');

    window.dispatchEvent(new CustomEvent('chat:activity', { detail: { message: 'another update' } }));
    window.dispatchEvent(new CustomEvent('chat:activity', { detail: { message: 'another update' } }));
    expect(capsule().get('.composer-capsule').classes()).toContain('is-running');

    const visibilityState = vi.spyOn(document, 'visibilityState', 'get');
    visibilityState.mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await flushPromises();
    expect(capsule().get('.composer-capsule').classes()).toContain('document-hidden');
    visibilityState.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await flushPromises();
    expect(capsule().get('.composer-capsule').classes()).not.toContain('document-hidden');
    visibilityState.mockRestore();

    focus?.mockReturnValue(false);
    window.dispatchEvent(new Event('blur'));
    await flushPromises();
    expect(capsule().get('.composer-capsule').classes()).toContain('document-hidden');
    expect(capsule().get('.composer-capsule').classes()).toContain('is-running');

    focus?.mockReturnValue(true);
    window.dispatchEvent(new Event('focus'));
    await flushPromises();
    expect(capsule().get('.composer-capsule').classes()).not.toContain('document-hidden');
    controller.stop();
    await flushPromises();
    expect(capsule().get('.composer-capsule').classes()).not.toContain('is-running');

    const remote = fixture.remoteSessions.at(-1);
    remote.remote.value = true;
    remote.running.value = true;
    await flushPromises();
    expect(capsule().get('.composer-capsule').classes()).toContain('is-running');
    remote.running.value = false;
    await flushPromises();
    expect(capsule().get('.composer-capsule').classes()).not.toContain('is-running');
  });

  it('does not send during IME composition or keyCode 229, preserves Shift+Enter, and sends on plain Enter', async() => {
    // risk: data integrity — composing IME text must never submit a partial message.
    const field = capsule().get('textarea.input');
    await field.setValue('日本語');

    const composing = keydown({ key: 'Enter', isComposing: true });
    expect(composing.defaultPrevented).toBe(false);
    const legacyIme = keydown({ key: 'Enter' }, 229);
    expect(legacyIme.defaultPrevented).toBe(false);
    expect(controller.messages.value).toHaveLength(0);

    const newline = keydown({ key: 'Enter', shiftKey: true });
    expect(newline.defaultPrevented).toBe(false);
    expect(controller.messages.value).toHaveLength(0);

    const send = keydown({ key: 'Enter' });
    expect(send.defaultPrevented).toBe(true);
    expect(controller.messages.value.map(message => message.kind === 'user' ? message.text : '')).toEqual(['日本語']);
  });

  it('queues the next draft through ChatController and removes it through QueueStrip', async() => {
    // risk: data integrity — a second submission during an active run must be queued rather than lost or sent twice.
    await capsule().get('textarea.input').setValue('first message');
    keydown({ key: 'Enter' });
    await flushPromises();
    await capsule().get('textarea.input').setValue('next message');
    keydown({ key: 'Enter' });
    await flushPromises();

    expect(controller.queue.value.map(message => message.text)).toEqual(['next message']);
    await capsule().get('.queue .rm').trigger('click');
    expect(controller.queue.value).toHaveLength(0);
  });

  it('keeps moved attachment, reply and use-case controls actionable', async() => {
    // risk: data integrity — context can still be removed or selected after its stack moves above the pill.
    controller.stageAttachment({ id: 'attachment-1', name: 'notes.txt', size: 20, kind: 'file', fileRef: { mime: 'text/plain' } } as any);
    window.dispatchEvent(new CustomEvent('chat:reply', { detail: { threadId: controller.thread.value.id, excerpt: 'Selected context' } }));
    fixture.useCases.open.value = true;
    const suggestion = { type: 'skill', slug: 'summarize', title: 'Summarize', description: 'Create a short summary' };
    fixture.useCases.strip.items.push(suggestion);
    await flushPromises();

    await capsule().get('.attach-tray .rm').trigger('click');
    await capsule().get('.reply-chip-x').trigger('click');
    await capsule().get('.usecase-row').trigger('click');
    expect(controller.staged.value).toHaveLength(0);
    expect(capsule().find('.reply-chip').exists()).toBe(false);
    expect(fixture.useCases.pick).toHaveBeenCalledWith(suggestion);
  });

  it('preserves the environment picker and remote model event bindings', async() => {
    // risk: routing — choosing an environment or its model must update the remote draft target without creating a new chat.
    const remote = fixture.remoteSessions.at(-1);
    await capsule().get('.environment-pill').trigger('click');
    const choice = capsule().findAll('.environment-menu button').find(button => button.text().includes('Fixture device'));
    expect(choice).toBeDefined();
    await choice!.trigger('click');
    expect(remote.select).toHaveBeenCalledWith(remote.pickerDevices.value[0]);

    remote.remote.value = true;
    await flushPromises();
    await capsule().get('select.remote-model').setValue(JSON.stringify(['openai', 'gpt-4o-mini']));
    expect(remote.model.value).toEqual(remote.models.value[0]);
  });

  it('opens the existing model modal from the relocated model chip', async() => {
    // risk: routing — relocating the chip must still open the existing model selector instead of losing access to it.
    const openModal = vi.spyOn(controller, 'openModal');
    await capsule().get('.composer-agent-picker .model-btn').trigger('click');
    expect(openModal).toHaveBeenCalledWith('model');
  });

  it('removes visibility listeners when the composer unmounts', () => {
    // risk: resource lifecycle — remounted chats must not retain stale visibility handlers.
    const removeDocumentListener = vi.spyOn(document, 'removeEventListener');
    const removeWindowListener = vi.spyOn(window, 'removeEventListener');
    capsule().unmount();
    wrapper = undefined;
    expect(removeDocumentListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    expect(removeWindowListener).toHaveBeenCalledWith('blur', expect.any(Function));
    expect(removeWindowListener).toHaveBeenCalledWith('focus', expect.any(Function));
    removeDocumentListener.mockRestore();
    removeWindowListener.mockRestore();
  });

  it('opens attachment controls, toggles mic, sends, and stops through their real components', async() => {
    // risk: user interaction — primary action controls must keep their original handlers after the layout change.
    await capsule().get('.attach-btn').trigger('click');
    await flushPromises();
    expect(capsule().find('.files-attach-menu[role="menu"]').exists()).toBe(true);

    await capsule().get('.mic-btn').trigger('click');
    expect(fixture.voiceAdapters.at(-1).toggle).toHaveBeenCalledTimes(1);

    await capsule().get('textarea.input').setValue('send from capsule');
    await capsule().get('.composer-send').trigger('click');
    await flushPromises();
    expect(controller.isRunning.value).toBe(true);
    expect(controller.messages.value.some(message => message.kind === 'user' && message.text === 'send from capsule')).toBe(true);

    await capsule().get('.composer-send.running').trigger('click');
    await flushPromises();
    expect(controller.isRunning.value).toBe(false);
  });

  it('keeps the RunControls stop and continue actions separate from the capsule send control', async() => {
    // risk: execution control — Stop/Continue remain reachable above the pill and invoke controller transitions.
    controller.send('local run');
    await capsule().get('.run-controls .stop').trigger('click');
    await flushPromises();
    expect(controller.isRunning.value).toBe(false);
    await capsule().get('.run-controls .continue').trigger('click');
    expect(controller.isRunning.value).toBe(true);
  });
});

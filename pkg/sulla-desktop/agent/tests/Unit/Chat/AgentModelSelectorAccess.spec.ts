// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';

const f = vi.hoisted(() => ({
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  providers: [] as any[],
}));

vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: f }));

import { AgentModelSelectorController } from '@pkg/pages/agent/AgentModelSelectorController';

describe('chat model selector access gate', () => {
  beforeEach(() => {
    f.invoke.mockReset();
    f.on.mockReset();
    f.removeListener.mockReset();
    f.providers = [
      { id: 'codex', name: 'OpenAI Codex', connected: true, accessMethod: 'subscription-cli', accessLabel: 'Subscription · CLI', selectable: true },
      { id: 'grok', name: 'Grok', connected: true, accessMethod: 'api-key', accessLabel: 'API · separate billing', selectable: true },
      { id: 'missing', name: 'Missing', accessMethod: 'subscription', accessLabel: 'Subscription · OAuth', selectable: true },
      { id: 'unknown', name: 'Unknown', connected: true, accessMethod: 'unknown', accessLabel: 'Connection unavailable', selectable: false, connectionStatus: 'unknown' },
      { id: 'disconnected', name: 'Disconnected', connected: false, accessMethod: 'api-key', accessLabel: 'API · separate billing', selectable: false },
    ];
    f.invoke.mockImplementation(async(channel: string, provider?: string) => {
      if (channel === 'model-provider:get-state') return { primaryProvider: '', activeModelId: '' };
      if (channel === 'agent-definitions:list') return [];
      if (channel === 'model-provider:get-providers') {
        return f.providers;
      }
      if (channel === 'model-provider:get-models') {
        return provider === 'codex'
          ? [{ id: 'codex', name: 'Auto (CLI default)', selectionMode: 'automatic' }, { id: 'gpt-6.2-sol', name: 'GPT-6.2 Sol', selectionMode: 'exact' }]
          : [{ id: 'grok-4.6', name: 'Grok 4.6', selectionMode: 'exact' }];
      }
      return [];
    });
  });

  afterEach(() => { document.body.innerHTML = '' });

  it('excludes unknown, disconnected, and undefined-connection providers and exposes safe labels', async() => {
    const selector = new AgentModelSelectorController({
      systemReady: ref(true), loading: ref(false), isRunning: ref(false), modelName: ref(''), modelMode: ref('remote'),
    });

    await selector.start();
    await selector.refresh();
    await nextTick();
    await Promise.resolve();

    expect(selector.providerGroups.value.map(group => group.providerId)).toEqual(['codex', 'grok']);
    expect(selector.providerGroups.value.map(group => group.accessLabel)).toEqual(['Subscription · CLI', 'API · separate billing']);
    expect(selector.providerGroups.value[0].models).toEqual(expect.arrayContaining([
      expect.objectContaining({ modelId: 'codex', selectionMode: 'automatic', providerAccessLabel: 'Subscription · CLI' }),
      expect.objectContaining({ modelId: 'gpt-6.2-sol', selectionMode: 'exact', providerAccessLabel: 'Subscription · CLI' }),
    ]));
    selector.dispose();
  });

  it('refreshes availability after a connection broadcast without changing the local chat choice', async() => {
    const onSelectForChat = vi.fn();
    const isRunning = ref(true);
    const selector = new AgentModelSelectorController({
      systemReady: ref(true), loading: ref(false), isRunning, modelName: ref(''), modelMode: ref('remote'), onSelectForChat,
    });

    await selector.start();
    await selector.refresh();
    await nextTick();
    await Promise.resolve();
    const grok = selector.providerGroups.value.find(group => group.providerId === 'grok')!;
    const chosen = grok.models[0];
    selector.selectModel(chosen);
    const chosenProvider = selector.activePrimaryProvider.value;
    const chosenModel = selector.activeModelId.value;
    expect(onSelectForChat).toHaveBeenCalledTimes(1);

    f.providers = [
      f.providers[0],
      { ...f.providers[1], connected: false, accessMethod: 'unknown', accessLabel: 'Connection unavailable', selectable: false, connectionStatus: 'unknown' },
    ];
    const stateListener = f.on.mock.calls.find(call => call[0] === 'model-provider:state-changed')?.[1] as ((event: unknown, state: unknown) => void) | undefined;
    expect(stateListener).toBeDefined();
    stateListener!({}, { primaryProvider: '', activeModelId: '' });
    await nextTick();
    await Promise.resolve();
    await nextTick();

    expect(selector.providerGroups.value.some(group => group.providerId === 'grok')).toBe(false);
    expect(selector.activePrimaryProvider.value).toBe(chosenProvider);
    expect(selector.activeModelId.value).toBe(chosenModel);
    const callsBeforeStalePick = onSelectForChat.mock.calls.length;
    selector.selectModel(chosen);
    expect(onSelectForChat).toHaveBeenCalledTimes(callsBeforeStalePick);
    expect(selector.activePrimaryProvider.value).toBe(chosenProvider);
    expect(selector.activeModelId.value).toBe(chosenModel);
    expect(isRunning.value).toBe(true);
    selector.dispose();
  });
});

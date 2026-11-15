// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
// @vitest-environment jsdom
/// <reference path="../../../../typings/shims-vue.d.ts" />

import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computed, nextTick, ref } from 'vue';

import ThreadStatusLine from '@pkg/pages/chat/components/composer/ThreadStatusLine.vue';
import { ChatControllerKey } from '@pkg/pages/chat/controller/useChatController';
import { chatActivityByTab } from '@pkg/pages/chat/messages/chatActivityStore';
import { AGENT_STATE_CLIENT_KEY } from '@pkg/services/agentState/AgentStateInjection';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn((): Promise<any> => Promise.resolve({ ok: true })) }));
vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: { invoke, send: vi.fn(), on: vi.fn(), removeListener: vi.fn() } }));

const row = (state: string, extra: Record<string, unknown> = {}) => ({
  key:                `job-1:0`,
  jobId:              'job-1',
  taskIndex:          0,
  parentJobId:        null,
  parentTaskIndex:    null,
  rootThreadId:       'thread-1',
  threadId:           'child-1',
  depth:              0,
  agentId:            'codex-sol-worker',
  label:              'Fix CI on #4323',
  visibility:         'hidden',
  state,
  stateReason:        null,
  killedByHuman:      false,
  waitingOnChildren:  0,
  startedAt:          '2026-11-14T20:00:00Z',
  endedAt:            null,
  lastActivityAt:     new Date(Date.now() - 600_000).toISOString(),
  lastCheckinAt:      null,
  lastCheckinSummary: null,
  canMessage:         true,
  canStop:            true,
  canOpen:            true,
  ...extra,
});

function mountLine(rows: any[], opts: { running?: boolean; heartbeat?: number | null } = {}) {
  const controller = {
    isRunning: computed(() => !!opts.running),
    messages:  computed(() => []),
    heartbeat: ref({ intervalMinutes: opts.heartbeat ?? null }),
  };
  const client = { snapshot: ref({ version: 1, generatedAt: '', rows }), apply: vi.fn() };
  return mount(ThreadStatusLine, {
    attachTo: document.body,
    global:   {
      provide: {
        [ChatControllerKey as symbol]:      controller,
        [AGENT_STATE_CLIENT_KEY as symbol]: client,
        'chat:activity-context':            { tabId: 'tab-1', backendThreadId: ref('thread-1') },
      },
    },
  });
}

afterEach(() => { document.body.innerHTML = ''; invoke.mockClear(); chatActivityByTab.clear() });

describe('the activity line above the message box', () => {
  // risk: the main thread showed nothing while agents worked or sat silent
  it('says Idle when nothing is running and nothing can be opened', () => {
    const w = mountLine([]);
    expect(w.find('.ta-line').text()).toContain('Idle');
    expect(w.find('.ta-line').attributes('disabled')).toBeDefined();
    expect(chatActivityByTab.get('tab-1')).toBe('idle');
    w.unmount();
  });

  it('flags a silent agent and tells the tab strip', () => {
    const w = mountLine([row('quiet')]);
    expect(w.find('.ta-line').text()).toContain('No progress');
    expect(chatActivityByTab.get('tab-1')).toBe('stalled');
    w.unmount();
    expect(chatActivityByTab.has('tab-1')).toBe(false);
  });

  it('nudges a silent agent from its row with one click', async() => {
    const w = mountLine([row('quiet')]);
    await w.find('.ta-line').trigger('click');
    const nudge = w.findAll('.ta-btn').find(b => b.text() === 'Nudge')!;
    await nudge.trigger('click');
    expect(invoke).toHaveBeenCalledWith('agents:message-job', 'job-1', 0, expect.stringContaining('Status check'));
    w.unmount();
  });

  // risk: one stray click stopped a long-running agent
  it('needs a second click to stop an agent', async() => {
    const w = mountLine([row('working')], { running: true });
    await w.find('.ta-line').trigger('click');
    const stop = () => w.find('.ta-danger');
    await stop().trigger('click');
    expect(invoke).not.toHaveBeenCalledWith('agents:stop-job', 'job-1');
    expect(stop().text()).toBe('Stop?');
    await stop().trigger('click');
    expect(invoke).toHaveBeenCalledWith('agents:stop-job', 'job-1');
    w.unmount();
  });

  it('expands a row in place and sends a typed message to that agent', async() => {
    const w = mountLine([row('working')], { running: true });
    await w.find('.ta-line').trigger('click');
    await w.find('.ta-head').trigger('click');
    await nextTick();
    await w.find('.ta-msg input').setValue('skip docs-only PRs');
    await w.find('.ta-msg').trigger('submit');
    expect(invoke).toHaveBeenCalledWith('agents:message-job', 'job-1', 0, 'skip docs-only PRs');
    w.unmount();
  });
});

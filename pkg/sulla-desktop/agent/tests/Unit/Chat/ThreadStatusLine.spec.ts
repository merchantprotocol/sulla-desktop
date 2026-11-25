// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
// @vitest-environment jsdom
/// <reference path="../../../../typings/shims-vue.d.ts" />

import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computed, nextTick, ref } from 'vue';

import { WindowTabStripState, windowTabStripKey } from '@pkg/composables/WindowTabStripState';
import ThreadStatusLine from '@pkg/pages/chat/components/composer/ThreadStatusLine.vue';
import { ChatControllerKey } from '@pkg/pages/chat/controller/useChatController';
import { AGENT_STATE_CLIENT_KEY } from '@pkg/services/agentState/AgentStateInjection';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

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

function mountLine(rows: any[], opts: { running?: boolean; heartbeat?: number | null; tabStrip?: WindowTabStripState } = {}) {
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
        [windowTabStripKey as symbol]:      opts.tabStrip ?? new WindowTabStripState(window, ipcRenderer),
        'chat:activity-context':            { tabId: 'tab-1', backendThreadId: ref('thread-1') },
      },
    },
  });
}

afterEach(() => { document.body.innerHTML = ''; invoke.mockClear() });

describe('the activity line above the message box', () => {
  // risk: the main thread showed nothing while agents worked or sat silent
  it('shows the waiting manager and all three active children without expanding the manager', async() => {
    const manager = row('parked', { jobId: 'manager', key: 'manager:0', waitingOnChildren: 3, label: 'Manager' });
    const children = [1, 2, 3].map(index => row('working', { jobId: `child-${ index }`, key: `child-${ index }:0`, parentJobId: 'manager', parentTaskIndex: 0, label: `Child ${ index }` }));
    const w = mountLine([manager, ...children], { heartbeat: 20 });
    expect(w.find('.ta-line').text()).toContain('3 agents running');
    expect(w.find('.ta-line').text()).toContain('1 agent waiting');
    await w.find('.ta-line').trigger('click');
    const names = w.findAll('.ta-name').map(name => name.text());
    expect(names.filter(name => name.startsWith('Manager') || name.startsWith('Child '))).toHaveLength(4);
    for (const child of children) expect(w.text()).toContain(child.label);
    w.unmount();
  });

  it('says Idle when nothing is running and nothing can be opened', () => {
    const tabStrip = new WindowTabStripState(window, ipcRenderer);
    const w = mountLine([], { tabStrip });

    expect(w.find('.ta-line').text()).toContain('Idle');
    expect(w.find('.ta-line').attributes('disabled')).toBeDefined();
    expect(tabStrip.readActivity('tab-1').snapshot?.state).toBe('idle');
    w.unmount();
  });

  it('flags a silent agent and tells the tab strip', () => {
    const tabStrip = new WindowTabStripState(window, ipcRenderer);
    const w = mountLine([row('quiet')], { tabStrip });

    expect(w.find('.ta-line').text()).toContain('No progress');
    expect(tabStrip.readActivity('tab-1').snapshot?.state).toBe('stalled');
    expect(tabStrip.readActivity('tab-1').snapshot?.detail).toContain('stopped responding');
    w.unmount();
    expect(tabStrip.readActivity('tab-1').snapshot).toBeUndefined();
  });

  it('nudges a silent agent from its row with one click', async() => {
    const w = mountLine([row('quiet')]);
    await w.find('.ta-line').trigger('click');
    const nudge = w.findAll('.ta-btn').find(b => b.attributes('aria-label')?.startsWith('Nudge'))!;
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

  // risk: a sub-agent still running under a manager that already finished
  // showed in the left Sub-agents panel but vanished from this tray
  it('lists a live sub-agent whose parent agent has already finished', async() => {
    const parent = row('done', { label: 'Manager', endedAt: new Date().toISOString() });
    const child = row('parked', { key: 'job-2:0', jobId: 'job-2', threadId: 'child-2', label: 'Waiting worker', parentJobId: 'job-1', parentTaskIndex: 0, depth: 1 });
    const w = mountLine([parent, child]);
    await w.find('.ta-line').trigger('click');
    const names = w.findAll('.ta-name').map(n => n.text());
    expect(names.some(n => n.startsWith('Waiting worker'))).toBe(true);
    expect(names.some(n => n.startsWith('Manager'))).toBe(false);
    w.unmount();
  });

  it('does not list a live sub-agent twice when its parent is live too', async() => {
    const parent = row('working', { label: 'Manager' });
    const child = row('working', { key: 'job-2:0', jobId: 'job-2', threadId: 'child-2', label: 'Worker', parentJobId: 'job-1', parentTaskIndex: 0, depth: 1 });
    const w = mountLine([parent, child], { running: true });
    await w.find('.ta-line').trigger('click');
    const names = w.findAll('.ta-name').map(n => n.text());
    expect(names).toHaveLength(2);
    expect(names.filter(name => name.startsWith('Manager'))).toHaveLength(1);
    expect(names.filter(name => name.startsWith('Worker'))).toHaveLength(1);
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

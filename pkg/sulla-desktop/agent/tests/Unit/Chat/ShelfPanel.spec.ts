// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
// @vitest-environment jsdom
/// <reference path="../../../../typings/shims-vue.d.ts" />

import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computed, ref } from 'vue';

const { invoke, createTab, closeTab, restoreHistoryTab } = vi.hoisted(() => ({
  invoke:    vi.fn((): Promise<any> => Promise.resolve({ ok: true, value: [] })),
  createTab: vi.fn(() => ({ id: 'new-tab' })),
  closeTab:  vi.fn(),
  restoreHistoryTab: vi.fn((id: string) => ({ id })),
}));
vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: { invoke, send: vi.fn(), on: vi.fn(), removeListener: vi.fn() } }));
vi.mock('@pkg/composables/useBrowserTabs', () => ({ useBrowserTabs: () => ({ createTab, closeTab, restoreHistoryTab }) }));

import ShelfPanel from '@pkg/pages/chat/components/composer/ShelfPanel.vue';
import { ChatControllerKey } from '@pkg/pages/chat/controller/useChatController';
import { RESUME_KEY } from '@pkg/pages/chat/messages/shelfNote';
import { AGENT_STATE_CLIENT_KEY } from '@pkg/services/agentState/AgentStateInjection';

const liveRow = { key: 'j:0', jobId: 'j', taskIndex: 0, parentJobId: null, parentTaskIndex: null, rootThreadId: 'thread-1', threadId: null, depth: 0, label: 'Billing manager', state: 'working', canMessage: true, canStop: true, lastActivityAt: '' };
const entry = { fileId: 'f1', slug: 'rc-billing', path: 'Projects/Shelf/rc-billing.md', goal: 'Finish billing', meta: { name: 'RC billing', status: 'shelved', shelvedAt: '2026-11-14T22:00:00Z', chatThreadId: 't_old', backendThreadId: 'thread-old', agentId: 'product-owner' } };

function mountPanel(request: any, opts: { running?: boolean; rows?: any[]; heartbeat?: number | null } = {}) {
  const controller = {
    isRunning:    computed(() => !!opts.running),
    messages:     computed(() => []),
    heartbeat:    ref({ intervalMinutes: opts.heartbeat ?? null }),
    thread:       ref({ id: 't_now', title: 'main thread', agentId: null }),
    send:         vi.fn(),
    setHeartbeat: vi.fn(),
  };
  return mount(ShelfPanel, {
    props:  { request },
    global: { provide: {
      [ChatControllerKey as symbol]:      controller,
      [AGENT_STATE_CLIENT_KEY as symbol]: { snapshot: ref({ rows: opts.rows ?? [] }), apply: vi.fn() },
      'chat:activity-context':            { tabId: 'tab-1', backendThreadId: ref('thread-1') },
    } },
  });
}

afterEach(() => { invoke.mockClear(); createTab.mockClear(); localStorage.clear() });

describe('/shelve', () => {
  // risk: shelving silently stopped work the user did not know was running
  it('lists exactly what will stop before anything happens', () => {
    const w = mountPanel({ mode: 'shelve' }, { rows: [liveRow], heartbeat: 20 });
    const text = w.find('.sp-list').text();
    expect(text).toContain('Billing manager');
    expect(text).toContain('Turn off the heartbeat (every 20 min)');
    expect(text).toContain('Projects/Shelf/main-thread.md');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('refuses while Sulla is mid-reply', () => {
    const w = mountPanel({ mode: 'shelve' }, { running: true });
    expect(w.text()).toContain('Sulla is mid-reply');
    expect(w.find('.sp-pri').attributes('disabled')).toBeDefined();
  });
});

describe('/resume and delete', () => {
  it('opens a fresh tab primed with the note and the original persona', async() => {
    invoke.mockResolvedValueOnce({ ok: true, value: [entry] });
    const w = mountPanel({ mode: 'resume' });
    await flushPromises();
    await w.findAll('button').find(b => b.text() === 'Resume')!.trigger('click');
    const pending = JSON.parse(localStorage.getItem(RESUME_KEY('new-tab'))!);
    expect(pending).toMatchObject({ agentId: 'product-owner', fileId: 'f1' });
    expect(pending.prompt).toContain('/mnt/sulla-files/Projects/Shelf/rc-billing.md');
  });

  // risk: deleting a shelved thread removed its conversation without being asked
  it('deletes only the note unless the conversation box is ticked', async() => {
    invoke.mockResolvedValueOnce({ ok: true, value: [entry] });
    const w = mountPanel({ mode: 'resume' });
    await flushPromises();
    await w.findAll('button').find(b => b.text() === 'Delete')!.trigger('click');
    await w.find('.sp-danger-solid').trigger('click');
    await flushPromises();
    expect(invoke).toHaveBeenCalledWith('thread-shelf:trash', 'f1');
    expect(invoke).not.toHaveBeenCalledWith('thread-shelf:delete-conversation', expect.anything());
  });

  it('refuses to delete while the shelved thread still has a running agent', async() => {
    invoke.mockResolvedValueOnce({ ok: true, value: [entry] });
    const w = mountPanel({ mode: 'resume' }, { rows: [{ ...liveRow, rootThreadId: 'thread-old' }] });
    await flushPromises();
    await w.findAll('button').find(b => b.text() === 'Delete')!.trigger('click');
    expect(w.text()).toContain('Stop Billing manager first');
    expect(w.find('.sp-danger-solid').exists()).toBe(false);
  });

  it('jumps straight to the delete confirmation for /shelve delete <name>', async() => {
    invoke.mockResolvedValueOnce({ ok: true, value: [entry] });
    const w = mountPanel({ mode: 'delete', name: 'RC billing' });
    await flushPromises();
    expect(w.find('.sp-confirm').exists()).toBe(true);
  });
});

describe('reopen original', () => {
  // risk: a fresh tab id opened a blank chat; History reopens in the original tab id
  it('restores the conversation in its original tab', async() => {
    invoke.mockResolvedValueOnce({ ok: true, value: [{ ...entry, meta: { ...entry.meta, tabId: 'tab-old' } }] });
    const w = mountPanel({ mode: 'resume' });
    await flushPromises();
    await w.findAll('button').find(b => b.text() === 'Reopen original')!.trigger('click');
    expect(restoreHistoryTab).toHaveBeenCalledWith('tab-old', expect.any(String));
    expect(localStorage.getItem('chat:tab:tab-old')).toContain('t_old');
  });
});

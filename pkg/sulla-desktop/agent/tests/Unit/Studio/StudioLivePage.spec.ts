// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
// @vitest-environment jsdom
/// <reference path="../../../../typings/shims-vue.d.ts" />

import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentConversationDetail, AgentsListResponse } from '@pkg/main/agentsIpc';

const invoke = vi.hoisted(() => vi.fn());

vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: { invoke } }));

import StudioLivePage from '@pkg/components/studio/StudioLivePage.vue';

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;

  constructor() {
    this.promise = new Promise(resolve => {
      this.resolve = resolve;
    });
  }
}

class LivePageFixture {
  private conversationReadCount = 0;

  readonly firstEntry = { kind: 'assistant' as const, ts: '2026-11-05T01:00:00Z', text: 'Initial activity' };
  readonly appendedEntry = { kind: 'tool' as const, ts: '2026-11-05T01:00:01Z', text: '{}', toolName: 'check_status' };

  readonly list: AgentsListResponse = {
    agents: [],
    heartbeat: null,
    jobs: [{
      jobId: 'job-1', status: 'running', createdAt: 1, finishedAt: null, taskCount: 1, parentAgentId: 'lead', parentTitle: 'Keep the feed stable', killedByHuman: false,
      tasks: [{ taskIndex: 0, agentId: 'worker', label: 'Worker', status: 'running', threadId: 'thread-1', startedAt: 1, depth: 1, kind: 'job', lastActivity: 'Working', lastActivityAt: 1, waitingForHuman: false, latestCheckin: null }],
    }],
    workflowRuns: [],
    updatedAt: Date.now(),
  };

  get conversationReads(): number {
    return this.conversationReadCount;
  }

  finishSelectedRun(): void {
    this.list.jobs[0].status = 'completed';
    this.list.jobs[0].tasks[0].status = 'completed';
  }

  responseWithLabel(label: string): AgentsListResponse {
    return {
      ...this.list,
      jobs: this.list.jobs.map(job => ({
        ...job,
        label,
        tasks: job.tasks.map(task => ({ ...task, label })),
      })),
    };
  }

  install(): void {
    invoke.mockImplementation(async(channel: string) => {
      if (channel === 'agents:list') return this.list;
      if (channel === 'agents:conversation') {
        this.conversationReadCount += 1;
        return this.detail(this.conversationReadCount === 1 ? [this.firstEntry] : [this.firstEntry, this.appendedEntry]);
      }
      throw new Error(`Unexpected IPC channel: ${ channel }`);
    });
  }

  private detail(entries: AgentConversationDetail['entries']): AgentConversationDetail {
    return { id: 'thread-1', channel: 'worker', title: 'Run', status: 'running', createdAt: '', lastActiveAt: '', entries, truncated: false, missingLog: false };
  }
}

describe('StudioLivePage activity refresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invoke.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the mounted timeline while background refreshes append activity', async() => {
    // risk: activity continuity — fleet operators must keep their reading and scroll position during polling.
    const fixture = new LivePageFixture();

    fixture.install();
    const wrapper = mount(StudioLivePage, { attachTo: document.body });

    await flushPromises();
    await wrapper.get('.agent-row').trigger('click');
    await flushPromises();
    const timeline = wrapper.get('.tl').element;

    expect(wrapper.text()).not.toContain('Loading activity…');
    expect(wrapper.text()).toContain(fixture.firstEntry.text);

    await vi.advanceTimersByTimeAsync(6_000);
    await flushPromises();

    expect(wrapper.get('.tl').element).toBe(timeline);
    expect(wrapper.text()).not.toContain('Loading activity…');
    expect(wrapper.text()).toContain(fixture.appendedEntry.toolName);
    wrapper.unmount();
  });

  it('keeps vanished selected activity readable but disables controls and stops detail polling', async() => {
    // risk: operator safety — a finished run must not retain stale message or stop controls.
    const fixture = new LivePageFixture();

    fixture.install();
    const wrapper = mount(StudioLivePage, { attachTo: document.body });

    await flushPromises();
    await wrapper.get('.agent-row').trigger('click');
    await flushPromises();
    const timeline = wrapper.get('.tl').element;

    fixture.finishSelectedRun();
    await vi.advanceTimersByTimeAsync(3_000);
    await flushPromises();

    expect(wrapper.get('.tl').element).toBe(timeline);
    expect(wrapper.text()).toContain('Finished — no longer running');
    expect(wrapper.find('.composer').exists()).toBe(false);
    expect(wrapper.find('.hero .btn.danger').exists()).toBe(false);
    const readsAfterFinalFetch = fixture.conversationReads;

    await vi.advanceTimersByTimeAsync(6_000);
    await flushPromises();
    expect(fixture.conversationReads).toBe(readsAfterFinalFetch);
    wrapper.unmount();
  });

  it('applies every overlapping slow list response once it resolves', async() => {
    // risk: activity continuity — polling must not starve when each request takes longer than the interval.
    const fixture = new LivePageFixture();
    const responses = [new Deferred<AgentsListResponse>(), new Deferred<AgentsListResponse>(), new Deferred<AgentsListResponse>()];
    let listReads = 0;

    invoke.mockImplementation(async(channel: string) => {
      if (channel === 'agents:list') return responses[listReads++].promise;
      throw new Error(`Unexpected IPC channel: ${ channel }`);
    });

    const wrapper = mount(StudioLivePage, { attachTo: document.body });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(listReads).toBe(3);

    responses[0].resolve(fixture.responseWithLabel('First response'));
    await flushPromises();
    expect(wrapper.text()).toContain('First response');

    responses[1].resolve(fixture.responseWithLabel('Second response'));
    await flushPromises();
    expect(wrapper.text()).toContain('Second response');

    responses[2].resolve(fixture.responseWithLabel('Third response'));
    await flushPromises();
    expect(wrapper.text()).toContain('Third response');
    wrapper.unmount();
  });

  it('applies an earlier response before a later response when it resolves first', async() => {
    // risk: activity continuity — valid responses must update the visible fleet in resolution order.
    const fixture = new LivePageFixture();
    const first = new Deferred<AgentsListResponse>();
    const second = new Deferred<AgentsListResponse>();
    let listReads = 0;

    invoke.mockImplementation(async(channel: string) => {
      if (channel === 'agents:list') return (listReads++ === 0 ? first.promise : second.promise);
      throw new Error(`Unexpected IPC channel: ${ channel }`);
    });

    const wrapper = mount(StudioLivePage, { attachTo: document.body });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(listReads).toBe(2);

    first.resolve(fixture.responseWithLabel('First response'));
    await flushPromises();
    expect(wrapper.text()).toContain('First response');

    second.resolve(fixture.responseWithLabel('Second response'));
    await flushPromises();
    expect(wrapper.text()).toContain('Second response');
    wrapper.unmount();
  });

  it('discards an older missing-list response that resolves after a newer live response', async() => {
    // risk: activity continuity — stale list data must not permanently stop a live selected detail feed.
    const fixture = new LivePageFixture();

    fixture.install();
    const wrapper = mount(StudioLivePage, { attachTo: document.body });
    await flushPromises();
    await wrapper.get('.agent-row').trigger('click');
    await flushPromises();

    const stale = new Deferred<AgentsListResponse>();
    const current = new Deferred<AgentsListResponse>();
    let listReads = 0;
    invoke.mockImplementation(async(channel: string) => {
      if (channel === 'agents:list') {
        listReads += 1;
        return listReads === 1 ? stale.promise : current.promise;
      }
      if (channel === 'agents:conversation') return { id: 'thread-1', channel: 'worker', title: 'Run', status: 'running', createdAt: '', lastActiveAt: '', entries: [fixture.firstEntry], truncated: false, missingLog: false };
      throw new Error(`Unexpected IPC channel: ${ channel }`);
    });

    await vi.advanceTimersByTimeAsync(6_000);
    expect(listReads).toBe(2);
    current.resolve(fixture.list);
    await flushPromises();
    stale.resolve({ ...fixture.list, jobs: [], updatedAt: fixture.list.updatedAt - 1 });
    await flushPromises();

    expect(wrapper.text()).not.toContain('Finished — no longer running');
    expect(wrapper.find('.hero .btn.danger').exists()).toBe(true);
    const readsBeforeNextPoll = invoke.mock.calls.filter(([channel]) => channel === 'agents:conversation').length;
    await vi.advanceTimersByTimeAsync(3_000);
    await flushPromises();
    expect(invoke.mock.calls.filter(([channel]) => channel === 'agents:conversation').length).toBeGreaterThan(readsBeforeNextPoll);
    wrapper.unmount();
  });

});

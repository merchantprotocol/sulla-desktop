// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, ref } from 'vue';

import AgentLanes from '@pkg/pages/chat/components/sidedock/AgentLanes.vue';
import DecisionsPanel from '@pkg/pages/chat/components/sidedock/DecisionsPanel.vue';
import SideDock from '@pkg/pages/chat/components/sidedock/SideDock.vue';
import { DOCK_POSITION_KEY, DockPositions, SIDE_RATIO_DEFAULT, SIDE_RATIO_KEY } from '@pkg/pages/chat/composables/useDockPosition';
import { ChatControllerKey } from '@pkg/pages/chat/controller/useChatController';
import { ActivityBinProjector, ActivityTrail, chatDecisions, ciStateOf, groupResults, laneStep } from '@pkg/pages/chat/messages/sideDock';
import { AGENT_STATE_CLIENT_KEY } from '@pkg/services/agentState/AgentStateInjection';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn((_channel: string): Promise<unknown> => Promise.resolve([])) }));
vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: { invoke, send: vi.fn(), on: vi.fn(), removeListener: vi.fn() } }));

const NOW = Date.now();
const row = (key: string, state: string, extra: Record<string, unknown> = {}): any => ({
  key,
  jobId:              key.split(':')[0],
  taskIndex:          0,
  parentJobId:        null,
  parentTaskIndex:    null,
  rootThreadId:       'thread-1',
  threadId:           `t-${ key }`,
  depth:              0,
  agentId:            'codex-luna-worker',
  label:              'Fix · FE #1358 deep-link scan',
  visibility:         'hidden',
  state,
  stateReason:        null,
  killedByHuman:      false,
  waitingOnChildren:  0,
  startedAt:          new Date(NOW - 134_000).toISOString(),
  endedAt:            state === 'done' ? new Date(NOW - 60_000).toISOString() : null,
  lastActivityAt:     new Date(NOW - 5_000).toISOString(),
  lastCheckinAt:      null,
  lastCheckinSummary: 'running pnpm test',
  canMessage:         true,
  canStop:            true,
  canOpen:            true,
  ...extra,
});
const question = (id: string, status = 'pending'): any => ({ id, kind: 'tool_question', createdAt: NOW - 180_000, questionId: `q-${ id }`, status, questions: [{ question: '4 product decisions', options: [] }] });
const result = (id: string, item: Record<string, unknown>): any => ({ id, kind: 'proactive', createdAt: NOW, headline: '', body: '', result: { items: [{ jobId: id, taskIndex: 0, label: id, status: 'completed', purpose: 'fix', verdict: 'Done', tone: 'ok', outcome: 'done', report: '', ...item }] } });

function mountWith(component: any, { rows = [] as any[], messages = [] as any[], artifacts = 0, props = {} } = {}) {
  const controller = {
    messages:  computed(() => messages),
    isRunning: computed(() => false),
    thread:    ref({ id: 'chat-1' }),
    artifacts: ref({ list: Array.from({ length: artifacts }, (_, i) => ({ id: `a${ i }` })), activeId: null }),
  };
  return mount(component, {
    props,
    attachTo: document.body,
    global:   {
      provide: {
        [ChatControllerKey as symbol]:      controller,
        [AGENT_STATE_CLIENT_KEY as symbol]: { snapshot: ref({ version: 1, generatedAt: '', rows }), apply: vi.fn() },
        'chat:activity-context':            { tabId: 'tab-1', backendThreadId: ref('thread-1') },
        'chat:open-subagent-conversation':  undefined,
      },
    },
  });
}

beforeEach(() => { localStorage.clear(); DockPositions.resetForTests(); invoke.mockResolvedValue([]) });
afterEach(() => { document.body.innerHTML = ''; invoke.mockClear() });

describe('where the dock lives', () => {
  // risk: the choice must hold for every chat and survive a restart
  it('defaults to the bottom and remembers a move to the side', () => {
    expect(DockPositions.use().position.value).toBe('bottom');
    DockPositions.use().setPosition('side');
    expect(localStorage.getItem(DOCK_POSITION_KEY)).toBe('side');
    DockPositions.resetForTests();
    expect(DockPositions.use().position.value).toBe('side');
  });

  it('moves back to the bottom from the tab row', async() => {
    DockPositions.use().setPosition('side');
    const dock = mountWith(SideDock);
    await dock.find('.sdk-move').trigger('click');
    expect(DockPositions.use().position.value).toBe('bottom');
  });
});

describe('resizing the side column', () => {
  // risk: the column had a fixed width; the user wants to drag its edge and keep the size
  it('follows a drag on its edge, saves the share on release, and keeps it after a restart', async() => {
    DockPositions.use().setPosition('side');
    const dock = mountWith(SideDock);
    const root = dock.element as HTMLElement;
    Object.defineProperty(root, 'offsetParent', { value: { getBoundingClientRect: () => ({ right: 1000, width: 1000 }) } });
    const handle = dock.find('.sdk-resize');

    await handle.trigger('pointerdown', { button: 0, pointerId: 1, clientX: 680 });
    handle.element.dispatchEvent(Object.assign(new Event('pointermove'), { clientX: 600, pointerId: 1 }));
    expect(DockPositions.use().sideRatio.value).toBeCloseTo(0.4);
    expect(localStorage.getItem(SIDE_RATIO_KEY)).toBeNull();
    handle.element.dispatchEvent(Object.assign(new Event('pointerup'), { clientX: 600, pointerId: 1 }));
    expect(localStorage.getItem(SIDE_RATIO_KEY)).toBe('0.4');

    DockPositions.resetForTests();
    expect(DockPositions.use().sideRatio.value).toBeCloseTo(0.4);
  });

  it('never goes past its limits, and a double-click resets it', async() => {
    const dock = mountWith(SideDock);
    DockPositions.use().setSideRatio(5);
    expect(DockPositions.use().sideRatio.value).toBe(0.7);
    await dock.find('.sdk-resize').trigger('dblclick');
    expect(DockPositions.use().sideRatio.value).toBe(SIDE_RATIO_DEFAULT);
  });
});

describe('the side dock tabs', () => {
  // risk: the user could not tell anything needed them from the tab row
  it('badges what needs you and offers Artifacts only when the chat has some', async() => {
    invoke.mockImplementation(channel => Promise.resolve(channel === 'decisions:conversation' ? [{ id: 'q-m1', conversationId: 'thread-1', kind: 'question', status: 'expired', attention: 'active', createdAt: NOW, expiresAt: 1, title: 'Question', questions: [] }] : []));
    const plain = mountWith(SideDock, { messages: [question('m1')] });
    await flushPromises();
    expect(plain.findAll('.sdk-tab').map(t => t.text())).toEqual(['Sulla', 'Results', 'For You1', 'Files']);
    const withArtifacts = mountWith(SideDock, { artifacts: 2 });
    expect(withArtifacts.findAll('.sdk-tab').map(t => t.text())).toContain('Artifacts2');
    await withArtifacts.findAll('.sdk-tab')[1].trigger('click');
    expect(withArtifacts.find('.sdk-tab[aria-selected="true"]').text()).toBe('Results');
  });
});

describe('agent lanes', () => {
  // risk: live activity was not recognisable; a child agent looked unrelated to its parent
  it('links requests to For You, shows live child relationships and folds finished ones', async() => {
    invoke.mockImplementation(channel => Promise.resolve(channel === 'decisions:conversation' ? [{ id: 'q-m1', conversationId: 'thread-1', kind: 'question', status: 'expired', attention: 'active', createdAt: NOW, expiresAt: 1, title: 'Question', questions: [] }] : []));
    const lanes = mountWith(AgentLanes, {
      messages: [question('m1')],
      rows:     [row('j1:0', 'working'), row('j2:0', 'working', { agentId: 'opus-worker', label: 'Review of the fix', parentJobId: 'j1', parentTaskIndex: 0 }), row('j3:0', 'done', { label: 'Review · Astra #4339' })],
    });
    await flushPromises();
    expect(lanes.find('.wy-list').exists()).toBe(false);
    expect(lanes.text()).toContain('For You');
    expect(lanes.find('.ln-sum').text()).toMatch(/^Needs you·1 request in For You·2 agents running/);
    const rows = lanes.findAll('.ln-row');
    expect(rows[0].find('.ln-av').classes()).toContain('ln-spin');
    expect(rows[0].find('.ln-step').text()).toContain('running pnpm test');
    expect(rows[0].find('.ln-step').text()).toContain('Model / effort not reported');
    expect(rows[1].classes()).toContain('ln-child');
    expect(rows[1].find('.ln-av').attributes('title')).toBe('opus-worker · started by codex-luna-worker');
    expect(lanes.find('.ln-fin summary').text()).toContain('Finished · 1');
  });

  it('groups exact follow-ups, keeps unlinked work separate and preserves collapse while live state changes', async() => {
    const build = row('build:0', 'working', { label: 'Build invoice' });
    const review = row('review:0', 'working', { label: 'Review invoice', followUpOf: { jobId: 'build', taskIndex: 0 } });
    const unrelated = row('other:0', 'working', { label: 'Review invoice' });
    const lanes = mountWith(AgentLanes, { rows: [build, review, unrelated] });
    const groups = lanes.findAll('.ln-work');
    expect(groups).toHaveLength(2);
    expect(groups[0].find('.ln-work-heading').text()).toContain('Build invoice');
    expect(groups[0].findAll('.ln-agent')).toHaveLength(2);
    expect(groups[0].text()).toContain('Follow-up to Build invoice');
    expect(groups[1].find('.ln-work-heading').text()).toContain('Unlinked work');
    (groups[0].element as HTMLDetailsElement).open = false; await groups[0].trigger('toggle');
    const client = lanes.vm.$.appContext.provides[AGENT_STATE_CLIENT_KEY as symbol];
    client.snapshot.value = { version: 2, rows: [{ ...build, state: 'done' }, review, unrelated] };
    await flushPromises();
    expect((lanes.find('.ln-work').element as HTMLDetailsElement).open).toBe(false);
    expect(lanes.find('.ln-work').text()).toContain('Earlier task · Reported done');
    expect(lanes.find('.ln-work').findAll('.ln-agent')).toHaveLength(2);
  });

  // risk: in a narrow column the agent's name crowded the task out entirely
  it('leads with the task, tags the agent on its avatar, and opens details on click', async() => {
    const lanes = mountWith(AgentLanes, { rows: [row('j1:0', 'working', { agentId: 'codex-sol-worker', lastCheckinSummary: 'Pushed fix commit bb3f01443952aea49f2eff28109f09d6a7954975' })] });
    const lane = lanes.find('.ln-agent');
    expect(lane.find('.ln-l1 .ln-task').text()).toBe('Fix · FE #1358 deep-link scan');
    expect(lane.find('.ln-av').text()).toBe('CS');
    expect(lane.find('.ln-step').text()).toContain('Model / effort not reported');
    expect(lane.find('.ln-more').exists()).toBe(false);

    await lane.find('.ln-step').trigger('click');
    expect(lanes.find('.ln-more').text()).toContain('codex-sol-worker');
    expect(lanes.find('.ln-more').text()).toContain('bb3f014');
    expect(lanes.find('.ln-msg input').exists()).toBe(true);

    await lanes.find('.ln-chev').trigger('click');
    expect(lanes.find('.ln-more').exists()).toBe(false);
  });

  it('asks before stopping an agent', async() => {
    const lanes = mountWith(AgentLanes, { rows: [row('j1:0', 'working')] });
    const stop = lanes.find('.ln-stop');
    await stop.trigger('click');
    expect(stop.attributes('aria-label')).toBe('Click again to stop');
  });
});

describe('decisions', () => {
  it('lists open ones first and shows what you chose', () => {
    const records: any[] = [
      { id: 'q-a', conversationId: 'thread-1', channel: 'c', title: 'Chat roles?', kind: 'question', status: 'answered', createdAt: 2, expiresAt: 3, answers: [{ question: 'Chat roles?', selected: ['DMs for everyone'] }] },
      { id: 'q-b', conversationId: 'thread-1', channel: 'c', title: 'Rate timing?', kind: 'question', status: 'pending', createdAt: 1, expiresAt: NOW + 600_000 },
      { id: 'q-c', conversationId: 'other', channel: 'c', title: 'Elsewhere', kind: 'question', status: 'pending', createdAt: 5, expiresAt: 6 },
    ];
    const mine = chatDecisions(records, ['thread-1']);
    expect(mine.map(r => r.id)).toEqual(['q-b', 'q-a']);
    const panel = mountWith(DecisionsPanel, { props: { decisions: mine }, messages: [{ ...question('m1'), questionId: 'q-b' }] });
    expect(panel.findAll('.dc-item')[0].find('.dc-btn').text()).toBe('Answer');
    expect(panel.findAll('.dc-item')[1].find('.dc-a').text()).toBe('DMs for everyone');
  });
});

describe('results by outcome and kind of work', () => {
  // risk: every card landed in "Other results" (the classifier fell back) and a re-delivered card showed twice
  it('puts failures first, then groups by the task label, one card per job', () => {
    const groups = groupResults([
      result('merged', { merges: [{ pr: '#4339', sha: 'f60ddf0' }] }),
      result('failed', { status: 'error', tone: 'bad', problem: 'test timed out' }),
      result('j-fix', { label: 'Fix · #4350 chat grants', purpose: 'other' }),
      result('j-fix', { label: 'Fix · #4350 chat grants', purpose: 'other', outcome: 'second delivery' }),
      result('j-rev', { label: 'Re-check · Astra FE #1358', purpose: 'other' }),
      result('j-odd', { label: 'Something else', purpose: 'other' }),
      { id: 'pin', kind: 'sulla', createdAt: 0, text: 'Freeze the rate when time is approved', pinned: true } as any,
    ]);
    expect(groups.needsAction.map(e => e.item.jobId)).toEqual(['failed']);
    expect(groups.sections.map(s => [s.key, s.items.map(e => e.item.jobId)])).toEqual([
      ['shipped', ['merged']], ['reviews', ['j-rev']], ['fixes', ['j-fix']], ['other', ['j-odd']],
    ]);
    expect(groups.sections.find(s => s.key === 'fixes')!.items[0].item.outcome).toBe('second delivery');
    expect(groups.pinned[0].text).toBe('Freeze the rate when time is approved');
  });
});

describe('a failure that was retried', () => {
  // risk: two reviews blocked at 17:17 stayed under Needs action after their retries finished at 17:23
  it('no longer needs action once a later run of the same task finished', () => {
    const groups = groupResults([
      result('j-a', { label: 'Review · Astra #4350 re-review', status: 'blocked', tone: 'warn' }),
      result('j-b', { label: 'Review · Astra #4352 review', status: 'blocked', tone: 'warn' }),
      result('j-a2', { label: 'Review · Astra #4350 re-review (retry)', followUpOf: { jobId: 'j-a', taskIndex: 0 } }),
    ]);
    expect(groups.needsAction.map(e => e.item.jobId)).toEqual(['j-b']);
  });
  // risk: "Review · Astra #4352 round 2" stayed under Needs action after its "(final)" rerun finished
  it('a "(final)" rerun settles it too', () => {
    const groups = groupResults([
      result('j-a', { label: 'Review · Astra #4352 round 2', status: 'blocked', tone: 'warn' }),
      result('j-a2', { label: 'Review · Astra #4352 round 2 (final)', followUpOf: { jobId: 'j-a', taskIndex: 0 } }),
    ]);
    expect(groups.needsAction).toEqual([]);
  });
});

describe('the lane step and activity meter', () => {
  it('says what the agent is doing now, and a stalled agent reads flat', () => {
    expect(laneStep(row('j:0', 'working', { toolInFlight: { name: 'pnpm test', since: new Date(NOW - 120_000).toISOString() } }), NOW)).toContain('pnpm test');
    expect(laneStep(row('j:0', 'quiet', { lastActivityAt: new Date(NOW - 7 * 60_000).toISOString(), lastCheckinSummary: 'Design set' }), NOW)).toBe('No output for 7m · last: Design set');
    expect(laneStep(row('j:0', 'quiet', { runtimeAlive: true, lastActivityAt: new Date(NOW - 7 * 60_000).toISOString(), lastCheckinSummary: null }), NOW)).toBe('Quiet 7m · still running');
    // risk: a 40-character commit hash filled the lane's step line
    expect(laneStep(row('j:0', 'working', { lastCheckinSummary: 'Pushed fix commit bb3f01443952aea49f2eff28109f09d6a7954975 to the branch' }), NOW)).toBe('Pushed fix commit bb3f014 to the branch');
    const trail = new ActivityTrail();
    const binProjector = new ActivityBinProjector();
    const activityRow = row('j:0', 'working', { actionCount: 0 });
    trail.record([activityRow], NOW - 50_000);
    activityRow.actionCount = 4;
    trail.record([activityRow], NOW - 25_000);
    activityRow.lastActivityAt = new Date(NOW - 1_000).toISOString();
    trail.record([activityRow], NOW - 10_000);
    activityRow.actionCount = 7;
    trail.record([activityRow], NOW);
    trail.record([activityRow], NOW);
    const samples = trail.samples('j:0');
    const bins = binProjector.values(samples, NOW);
    expect(samples.map(sample => sample.count)).toEqual([4, 3]);
    expect(bins[22]).toBe(4);
    expect(bins[23]).toBe(3);
    expect(bins.reduce((a, b) => a + b, 0)).toBe(7);
    expect(binProjector.values([], NOW).every(n => n === 0)).toBe(true);
  });
});

describe('where an open PR\'s checks stand', () => {
  // risk: the user could not tell work was merged and waiting on GitHub
  it('shows checks running while an agent waits on GitHub for that PR, else what the result recorded', () => {
    const waiting = row('j9:0', 'parked', { label: 'Fix · #4351 round 3', waitReason: 'CI full-tests running on ee7ae6f', wakeAt: new Date(NOW + 5 * 60_000).toISOString() });
    const item: any = { label: 'Fix · #4351 rate lock', change: { pr: '#4351' } };
    expect(ciStateOf(item, [waiting], NOW)).toEqual({ text: 'checks running · next look in 5m', tone: 'run' });
    expect(ciStateOf({ ...item, checks: [{ name: 'a', passed: true }, { name: 'b', passed: false }] }, [], NOW)).toEqual({ text: '1 of 2 checks failed', tone: 'bad' });
    expect(ciStateOf({ label: 'Review · Astra' } as any, [waiting], NOW)).toBeNull();
  });
});

// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import type { DecisionRecord, DecisionRouteEntry, DecisionRouteHistoryEntry } from '@pkg/shared/decisions';
import { DecisionRouteResolver } from '../../../services/DecisionRouteResolver';
import { DecisionAuthorityPolicy } from '../../../services/DecisionAuthorityPolicy';
import { DecisionEscalationService } from '../../../services/DecisionEscalationService';
import { DecisionHolderNotifier, type DecisionHolderDelivery } from '../../../services/DecisionHolderNotifier';
import { DecisionService } from '../../../services/DecisionService';
import { LateDecisionAnswerHandler } from '../../../services/LateDecisionAnswerHandler';
import type { DecisionRoutePatch, DecisionSettlementStatus, DecisionTransitionActor } from '../../../repositories/DecisionRouteTransitionSqlBuilder';
import type { AgentJobTaskTarget } from '../../../database/models/AgentJobMessagingModel';

class MemoryDecisionStore {
  private readonly records = new Map<string, DecisionRecord>();
  readonly settleCalls: Array<{ id: string; actor: DecisionTransitionActor; status: DecisionSettlementStatus }> = [];
  askerTask?: AgentJobTaskTarget;
  readonly deliveredJobAnswers: Array<{ jobId: string; taskIndex: number; message: string }> = [];
  failOpenRoutedQuestionsOnce = false;
  lateChatAnswers: DecisionRecord[] = [];

  put(record: DecisionRecord): void { this.records.set(record.id, structuredClone(record)) }
  async insert(record: DecisionRecord): Promise<void> { this.put(record) }
  async settle(id: string, status: string, record: DecisionRecord): Promise<boolean> {
    const previous = this.records.get(id);
    if (!previous || !['pending', 'deferred'].includes(previous.status)) return false;
    this.put({ ...record, status: status as DecisionRecord['status'] });
    return true;
  }
  async findById(id: string): Promise<DecisionRecord | undefined> { const record = this.records.get(id); return record && structuredClone(record) }
  async findOpenQuestion(): Promise<undefined> { return undefined }
  async ancestry(): Promise<string[]> { return [] }
  async taskForThread(threadId: string): Promise<AgentJobTaskTarget | null> { return this.askerTask?.threadId === threadId ? this.askerTask : null }
  async expireOpenDecisions(): Promise<DecisionRecord[]> { return [] }
  async queueLateAnswer(record: DecisionRecord, answers: { question: string; selected: string[] }[]): Promise<DecisionRecord | undefined> {
    const current = this.records.get(record.id);
    const route = current?.route;
    const actor = record.answeredBy ?? { kind: 'human' as const };
    if (!current || current.answerDelivery || (!['pending', 'expired'].includes(current.status) && current.status !== 'answered') ||
      (current.status !== 'answered' && !['active', undefined].includes(current.attention)) ||
      (current.status === 'answered' && (current.answeredBy?.kind !== actor.kind || JSON.stringify(current.answers) !== JSON.stringify(answers)))) return undefined;
    if (actor.kind === 'agent' && (!route || route.authority !== 'any' || route.chain[route.holderIndex]?.threadId !== actor.threadId)) return undefined;
    const history: DecisionRouteHistoryEntry = {
      threadId: actor.kind === 'agent' ? actor.threadId ?? '' : route?.chain.at(-1)?.threadId ?? current.conversationId,
      agentId: actor.kind === 'agent' ? actor.agentId ?? 'agent' : 'human', action: 'answered', at: this.records.size,
      ...(actor.note ? { note: actor.note.slice(0, 500) } : {}),
    };
    const answered = { ...current, attention: 'answered' as const, answerDelivery: 'queued' as const,
      answeredBy: actor, answers, ...(route && current.status !== 'answered' ? { route: { ...route, history: [...route.history, history] } } : {}) };
    this.put(answered);
    this.lateChatAnswers.push(structuredClone(answered));
    return structuredClone(answered);
  }
  async recordJobAnswer(record: DecisionRecord, answers: { question: string; selected: string[] }[]): Promise<DecisionRecord | undefined> {
    const current = this.records.get(record.id);
    const actor = record.answeredBy ?? { kind: 'human' as const };
    if (!current || (current.status === 'answered' && (current.answerDelivery || JSON.stringify(current.answers) !== JSON.stringify(answers) || current.answeredBy?.kind !== actor.kind)) ||
      (!['pending', 'deferred', 'expired', 'answered'].includes(current.status) || current.attention === 'dismissed')) return undefined;
    const route = current.route;
    const history: DecisionRouteHistoryEntry = { threadId: actor.kind === 'agent' ? actor.threadId ?? '' : route?.chain.at(-1)?.threadId ?? current.conversationId,
      agentId: actor.kind === 'agent' ? actor.agentId ?? 'agent' : 'human', action: 'answered', at: this.records.size,
      ...(actor.note ? { note: actor.note.slice(0, 500) } : {}) };
    const answered = { ...current, status: 'answered' as const, attention: 'answered' as const, answerDelivery: 'queued' as const,
      answeredBy: actor, answers, ...(route && current.status !== 'answered' ? { route: { ...route, history: [...route.history, history] } } : {}) };
    this.put(answered);
    return structuredClone(answered);
  }
  async find(conversationId: string): Promise<{ id: string } | null> { return { id: conversationId } }
  async markJobAnswerDelivered(id: string): Promise<boolean> {
    const current = this.records.get(id);
    if (!current || current.answerDelivery !== 'queued') return false;
    this.put({ ...current, answerDelivery: 'delivered' });
    return true;
  }
  async openRoutedQuestions(): Promise<DecisionRecord[]> {
    if (this.failOpenRoutedQuestionsOnce) { this.failOpenRoutedQuestionsOnce = false; throw new Error('database not ready') }
    return [...this.records.values()].filter(record => record.kind === 'question' && record.status === 'pending' && record.attention === 'active' && record.route?.authority === 'any').map(record => structuredClone(record));
  }

  async claimHolder(id: string, expectedIndex: number, actor: DecisionTransitionActor, patch: DecisionRoutePatch): Promise<boolean> {
    const record = this.records.get(id);
    if (!record || record.status !== 'pending' || actor.kind !== 'system' || record.route?.holderIndex !== expectedIndex || record.route.deliveredAt != null) return false;
    this.put({ ...record, route: { ...record.route, ...patch } });
    return true;
  }

  async advanceHolder(id: string, expectedIndex: number, actor: DecisionTransitionActor, patch: DecisionRoutePatch,
    history: DecisionRouteHistoryEntry, deadlineNow?: number): Promise<boolean> {
    const record = this.records.get(id);
    const route = record?.route;
    if (!record || record.status !== 'pending' || !route || route.holderIndex !== expectedIndex) return false;
    if (actor.kind === 'agent' && (route.chain[expectedIndex]?.threadId !== actor.threadId || (record.kind === 'question' && route.authority !== 'any'))) return false;
    if (deadlineNow !== undefined && (route.holderDeadline == null || route.holderDeadline > deadlineNow)) return false;
    this.put({ ...record, route: { ...route, ...patch, history: [...route.history, history] } });
    return true;
  }

  async settleAs(id: string, expectedIndex: number, actor: DecisionTransitionActor, status: DecisionSettlementStatus,
    patch: Partial<Omit<DecisionRecord, 'route'>>, history: DecisionRouteHistoryEntry[] = []): Promise<boolean> {
    this.settleCalls.push({ id, actor, status });
    const record = this.records.get(id);
    const route = record?.route;
    if (!record || !route || !['pending', 'deferred'].includes(record.status) || (record.kind === 'question' && record.attention !== 'active')) return false;
    if (actor.kind === 'agent') {
      if (route.holderIndex !== expectedIndex || route.chain[expectedIndex]?.threadId !== actor.threadId) return false;
      if (record.kind === 'approval' ? status !== 'denied' : status !== 'answered' || route.authority !== 'any') return false;
    }
    if (actor.kind === 'system' && status !== 'expired') return false;
    this.put({ ...record, ...patch, status, route: { ...route, history: [...route.history, ...history] } });
    return true;
  }
}

class RecordingDelivery implements DecisionHolderDelivery {
  readonly delivered: Array<{ holder: string; message: string }> = [];
  unavailableTools = new Set<string>();
  activeChats = new Set<string>();
  queuedForNextBoundary = false;
  throwsOnDelivery = false;
  beforeDeliver?: () => void;

  async sendJob(input: { jobId: string; taskIndex: number; message: string }) {
    if (this.throwsOnDelivery) throw new Error('delivery unavailable');
    this.beforeDeliver?.();
    this.delivered.push({ holder: `${ input.jobId }:${ input.taskIndex }`, message: input.message });
    return { successBoolean: true, responseString: JSON.stringify(this.queuedForNextBoundary ? { deliveredLive: 0, queuedForNextBoundary: 1 } : { deliveredLive: 1 }) };
  }
  enqueueChat(_channel: string, threadId: string, entry: { notice: string }): boolean {
    if (this.throwsOnDelivery) throw new Error('delivery unavailable');
    this.beforeDeliver?.();
    this.delivered.push({ holder: threadId, message: entry.notice });
    return true;
  }
  async canUseTool(holder: DecisionRouteEntry): Promise<boolean> { return !this.unavailableTools.has(holder.threadId) }
  async humanIsActive(_channel: string, threadId: string): Promise<boolean> { return this.activeChats.has(threadId) }
  async canSteer(): Promise<boolean> { return true }
}

class FixedRouteResolver {
  constructor(private readonly chain: DecisionRouteEntry[], private readonly unavailable = new Set<string>()) {}
  async resolve(): Promise<DecisionRouteEntry[]> { return structuredClone(this.chain) }
  async liveness(holder: DecisionRouteEntry): Promise<'available' | 'unavailable'> { return this.unavailable.has(holder.threadId) ? 'unavailable' : 'available' }
}

class EscalationHarness {
  readonly store = new MemoryDecisionStore();
  readonly delivery = new RecordingDelivery();
  readonly notifier = new DecisionHolderNotifier(this.delivery);
  readonly authority = new DecisionAuthorityPolicy();
  readonly routeResolver: any;
  readonly escalation: DecisionEscalationService;
  readonly decisions: DecisionService;
  readonly askerMessages: Array<{ jobId: string; taskIndex: number; message: string }> = [];
  readonly chatAnswerWakes: Array<{ channel: string; type: string }> = [];
  now = 100;

  constructor(routes: any) {
    this.routeResolver = routes;
    this.escalation = new DecisionEscalationService(this.store as any, routes, this.authority, this.notifier,
      (actor, response) => this.decisions.resolveAs(actor, response), () => undefined, () => this.now);
    const lateAnswers = new LateDecisionAnswerHandler(this.store as any, this.store as any, { send: async(channel, message) => {
      this.chatAnswerWakes.push({ channel, type: message.type }); return true;
    } }, {
      send: async(jobId, taskIndex, message) => { this.askerMessages.push({ jobId, taskIndex, message }); return true },
    });
    this.decisions = new DecisionService(lateAnswers, {
      decisions: this.store as any, pendingDecisions: this.store as any,
      routeResolver: routes, authorityPolicy: this.authority, holderNotifier: this.notifier,
      askerWaiter: { park: async() => undefined, parkQuestionAsker: async() => false }, escalation: this.escalation as any,
    });
  }

  async askQuestion() {
    const request = await this.decisions.request({
      kind: 'question', conversationId: 'asker', channel: 'chat', title: 'Which option?', attention: 'active',
      questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }],
    });
    await this.escalation.start(request.record);
    return request;
  }
}

const agent = (threadId: string, agentId: string, jobId?: string): DecisionRouteEntry => ({
  threadId, channel: 'chat', agentId, ...(jobId ? { jobId, taskIndex: 0 } : {}), kind: 'agent',
});
const human: DecisionRouteEntry = { threadId: 'root-chat', channel: 'chat', agentId: 'human', kind: 'human' };
const question = (id: string, route: NonNullable<DecisionRecord['route']>, conversationId = 'asker'): DecisionRecord => ({
  id, conversationId, channel: 'chat', title: 'Which option?', kind: 'question', status: 'pending', attention: 'active',
  createdAt: 1, expiresAt: 1_000_000, questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }], route,
});

describe('DecisionEscalationService', () => {
  it('durably advances to the human when holder delivery keeps throwing', async() => {
    // risk: availability — a broken notifier must never leave a decision owned by an agent without a deadline.
    const chain = [agent('parent', 'manager', 'parent-job'), agent('root-chat', 'root-agent'), human];
    const harness = new EscalationHarness(new FixedRouteResolver(chain));
    harness.delivery.throwsOnDelivery = true;
    const record = question('notifier-failure', { authority: 'any', chain, holderIndex: 0, holderSince: harness.now, history: [] });
    harness.store.put(record);

    await expect(harness.escalation.start(record)).resolves.toBeUndefined();
    const current = (await harness.store.findById(record.id))!;

    expect(current.route).toMatchObject({ holderIndex: 2, history: [
      expect.objectContaining({ agentId: 'manager', action: 'unavailable' }),
      expect.objectContaining({ agentId: 'root-agent', action: 'unavailable' }),
    ] });
    expect(current.route?.chain[current.route.holderIndex]?.kind).toBe('human');
  });

  it('walks parent then root before the human, using the three-minute delivery window and five-minute level cap', async() => {
    // risk: availability — each parent gets a bounded chance to answer before the question reaches the human.
    const chain = [agent('parent', 'manager', 'parent-job'), agent('root-chat', 'root-agent'), human];
    const harness = new EscalationHarness(new FixedRouteResolver(chain));
    harness.delivery.beforeDeliver = () => { harness.now += 4 * 60_000 };
    const record = question('walk', { authority: 'any', chain, holderIndex: 0, holderSince: harness.now, history: [] });
    harness.store.put(record);
    await Promise.all([harness.escalation.start(record), harness.escalation.start(record)]);

    let current = (await harness.store.findById(record.id))!;
    expect(current.route).toMatchObject({ holderIndex: 0, deliveredAt: 240_100, holderDeadline: 300_100 });
    expect(harness.delivery.delivered).toHaveLength(1);
    harness.delivery.beforeDeliver = undefined;
    harness.now = current.route!.holderDeadline!;
    await harness.escalation.reconcile();
    current = (await harness.store.findById(record.id))!;
    expect(current.route).toMatchObject({ holderIndex: 1, history: [expect.objectContaining({ agentId: 'manager', action: 'timeout' })] });
    expect(harness.delivery.delivered.map(delivery => delivery.holder)).toEqual(['parent-job:0', 'root-chat']);

    harness.now = current.route!.holderDeadline!;
    await harness.escalation.reconcile();
    current = (await harness.store.findById(record.id))!;
    expect(current.route).toMatchObject({ holderIndex: 2, history: [
      expect.objectContaining({ agentId: 'manager', action: 'timeout' }),
      expect.objectContaining({ agentId: 'root-agent', action: 'timeout' }),
    ] });
    expect(harness.delivery.delivered).toHaveLength(2);
  });

  it('skips a finished holder and a parent blocked in a synchronous spawn at once, recording unavailable', async() => {
    // risk: availability — finished or deadlocked parents must not consume a five-minute holder window.
    for (const [id, status, spawnMode] of [['finished', 'completed', 'async'], ['sync-child', 'running', 'sync']] as const) {
      const tasks = new Map<string, AgentJobTaskTarget>([
        ['child', { jobId: 'child-job', taskIndex: 0, jobStatus: 'running', taskStatus: 'running', parentThreadId: 'parent', parentChannel: 'chat', spawnMode }],
        ['parent', { jobId: 'parent-job', taskIndex: 0, jobStatus: status, taskStatus: status, parentThreadId: 'root-chat', parentChannel: 'chat', parentJobId: null }],
      ]);
      const resolver = new DecisionRouteResolver({ taskForThread: async(threadId: string) => tasks.get(threadId) ?? null });
      const harness = new EscalationHarness(resolver);
      const requested = await harness.decisions.requestQuestion({
        conversationId: 'child', channel: 'chat', title: `Choose (${ id })`,
        questions: [{ question: 'Choose?', options: [{ label: 'A' }] }],
      });
      const current = (await harness.store.findById(requested.record.id))!;
      expect(current.route).toMatchObject({ holderIndex: 1, history: [expect.objectContaining({ threadId: 'parent', action: 'unavailable' })] });
      expect(harness.delivery.delivered.map(delivery => delivery.holder)).toEqual(['root-chat']);
      expect(current.route!.holderDeadline).toBe(harness.now + DecisionEscalationService.DELIVERY_WINDOW_MS);
    }
  });

  it('skips a holder without answer_decision, re-delivers a missing startup notice, and advances an overdue one', async() => {
    // risk: user communication — tool capability and restart loss cannot strand a question on an unreachable parent.
    const chain = [agent('parent', 'manager', 'parent-job'), human];
    const harness = new EscalationHarness(new FixedRouteResolver(chain));
    harness.delivery.unavailableTools.add('parent');
    const noTool = question('no-tool', { authority: 'any', chain, holderIndex: 0, holderSince: 100, history: [] });
    harness.store.put(noTool);
    await harness.escalation.start(noTool);
    expect((await harness.store.findById(noTool.id))!.route).toMatchObject({ holderIndex: 1, history: [expect.objectContaining({ action: 'unavailable' })] });
    expect(harness.delivery.delivered).toHaveLength(0);

    const chatChain = [agent('parent', 'manager', 'parent-job'), agent('root-chat', 'root-agent'), human];
    const recovering = new EscalationHarness(new FixedRouteResolver(chatChain));
    const missingNotice = question('startup-redelivery', { authority: 'any', chain: chatChain, holderIndex: 1, holderSince: 100, deliveredAt: 101, holderDeadline: 180_101, history: [] });
    recovering.store.put(missingNotice);
    await recovering.escalation.reconcile();
    expect(recovering.delivery.delivered).toHaveLength(1);
    expect((await recovering.store.findById(missingNotice.id))!.route).toMatchObject({ holderIndex: 1, deliveredAt: 101, holderDeadline: 180_101 });

    const deliveryMissing = new EscalationHarness(new FixedRouteResolver(chain));
    const noDeliveryTimestamp = question('missing-delivery-at', { authority: 'any', chain, holderIndex: 0, holderSince: 100, history: [] });
    deliveryMissing.store.put(noDeliveryTimestamp);
    await deliveryMissing.escalation.reconcile();
    expect((await deliveryMissing.store.findById(noDeliveryTimestamp.id))!.route).toMatchObject({ deliveredAt: 100, holderDeadline: 180_100 });

    const restarting = new EscalationHarness(new FixedRouteResolver(chain));
    const overdue = question('startup-timeout', { authority: 'any', chain, holderIndex: 0, holderSince: 100, deliveredAt: 101, holderDeadline: 99, history: [] });
    restarting.store.put(overdue);
    restarting.now = 100;
    await restarting.escalation.reconcile();
    expect((await restarting.store.findById(overdue.id))!.route).toMatchObject({ holderIndex: 1, history: [expect.objectContaining({ action: 'timeout' })] });
  });

  it('skips the root chat agent when the human is active in that chat', async() => {
    // risk: user communication — do not wake an agent to answer while the human is already present in its chat.
    const chain = [agent('parent', 'manager', 'parent-job'), agent('root-chat', 'root-agent'), human];
    const harness = new EscalationHarness(new FixedRouteResolver(chain));
    harness.delivery.activeChats.add('root-chat');
    const record = question('human-present', { authority: 'any', chain, holderIndex: 1, holderSince: harness.now,
      history: [{ threadId: 'parent', agentId: 'manager', action: 'passed', at: 99 }] });
    harness.store.put(record);
    await harness.escalation.start(record);

    expect((await harness.store.findById(record.id))!.route).toMatchObject({ holderIndex: 2, history: [
      expect.objectContaining({ agentId: 'manager', action: 'passed' }),
      expect.objectContaining({ agentId: 'root-agent', action: 'unavailable' }),
    ] });
    expect(harness.delivery.delivered).toHaveLength(0);
  });

  it('keeps a job holder when its durable notice is queued for the next model boundary', async() => {
    // risk: availability — a parked-to-running race must not pass a question after its durable mailbox accepts it.
    const chain = [agent('parent', 'manager', 'parent-job'), human];
    const harness = new EscalationHarness(new FixedRouteResolver(chain));
    harness.delivery.queuedForNextBoundary = true;

    const requested = await harness.askQuestion();
    expect((await harness.store.findById(requested.record.id))!.route).toMatchObject({
      holderIndex: 0, deliveredAt: harness.now,
      holderDeadline: harness.now + DecisionEscalationService.DELIVERY_WINDOW_MS,
    });
    expect(harness.delivery.delivered).toHaveLength(1);
  });

  it('rejects a non-holder and the former holder after a pass at the service authority gate', async() => {
    // risk: authorization — neither another live ancestor nor a former holder may act before the SQL CAS is reached.
    const chain = [agent('parent', 'manager', 'parent-job'), agent('root-chat', 'root-agent'), human];
    const harness = new EscalationHarness(new FixedRouteResolver(chain));
    const requested = await harness.askQuestion();
    const original = (await harness.store.findById(requested.record.id))!;

    await expect(harness.escalation.authorize(original, { kind: 'agent', threadId: 'root-chat' }, 'answer')).resolves.toBe(false);
    await expect(harness.escalation.pass('parent', requested.record.id)).resolves.toMatchObject({ settled: true });
    const afterPass = (await harness.store.findById(requested.record.id))!;
    await expect(harness.escalation.authorize(afterPass, { kind: 'agent', threadId: 'parent' }, 'answer')).resolves.toBe(false);
  });

  it('retries startup redelivery after the first durable sweep fails', async() => {
    // risk: availability — a database startup failure must not suppress recovery of a root-chat notice already marked delivered.
    const chain = [agent('root-chat', 'root-agent'), human];
    const harness = new EscalationHarness(new FixedRouteResolver(chain));
    const persistedNotice = question('startup-retry', { authority: 'any', chain, holderIndex: 0,
      holderSince: harness.now, deliveredAt: harness.now, holderDeadline: harness.now + DecisionEscalationService.DELIVERY_WINDOW_MS, history: [] });
    harness.store.put(persistedNotice);
    harness.store.failOpenRoutedQuestionsOnce = true;

    await expect(harness.escalation.reconcile()).rejects.toThrow('database not ready');
    await harness.escalation.reconcile();

    expect(harness.delivery.delivered).toHaveLength(1);
    expect(harness.delivery.delivered[0].holder).toBe('root-chat');
  });

  it('settles human answers against the current holder and rejects that holder after settlement or pass', async() => {
    // risk: concurrency — a human answer and a delayed agent response share one waiter and only the first valid transition wins.
    const chain = [agent('parent', 'manager', 'parent-job'), agent('root-chat', 'root-agent'), human];
    const harness = new EscalationHarness(new FixedRouteResolver(chain));
    const requested = await harness.askQuestion();
    await expect(harness.decisions.answerAsAgent('root-chat', requested.record.id, 'answer', [{ question: 'Choose?', selected: ['B'] }]))
      .resolves.toMatchObject({ settled: false });
    const humanAnswer = {
      id: requested.record.id, conversationId: 'asker', action: 'answered', answers: [{ question: 'Which?', selected: ['A'] }],
    } as const;
    await expect(harness.decisions.answerAsAgent('parent', requested.record.id, 'pass')).resolves.toMatchObject({ settled: true });
    await expect(harness.decisions.answerAsAgent('root-chat', requested.record.id, 'pass')).resolves.toMatchObject({ settled: true });
    await expect(harness.decisions.resolveAs({ kind: 'human' }, humanAnswer)).resolves.toMatchObject({ settled: true });
    await expect(harness.decisions.answerAsAgent('parent', requested.record.id, 'answer', [{ question: 'Choose?', selected: ['B'] }]))
      .resolves.toMatchObject({ settled: false });
    await expect(requested.result).resolves.toMatchObject({ status: 'answered', answeredBy: { kind: 'human' } });
    expect((await harness.store.findById(requested.record.id))!.route?.history).toEqual([
      expect.objectContaining({ threadId: 'parent', agentId: 'manager', action: 'passed' }),
      expect.objectContaining({ threadId: 'root-chat', agentId: 'root-agent', action: 'passed' }),
      expect.objectContaining({ threadId: 'root-chat', agentId: 'human', action: 'answered' }),
    ]);

    const passed = await harness.askQuestion();
    await expect(harness.decisions.answerAsAgent('parent', passed.record.id, 'pass', undefined, 'x'.repeat(650)))
      .resolves.toMatchObject({ settled: true });
    const afterPass = (await harness.store.findById(passed.record.id))!;
    expect(afterPass.route).toMatchObject({ holderIndex: 1, history: [expect.objectContaining({ action: 'passed', note: 'x'.repeat(500) })] });
    await expect(harness.decisions.answerAsAgent('parent', passed.record.id, 'answer', [{ question: 'Choose?', selected: ['A'] }]))
      .resolves.toMatchObject({ settled: false });
    await expect(harness.decisions.answerAsAgent('root-chat', passed.record.id, 'pass')).resolves.toMatchObject({ settled: true });
    await harness.decisions.resolveAs({ kind: 'human' }, {
      id: passed.record.id, conversationId: 'asker', action: 'answered', answers: [{ question: 'Which?', selected: ['A'] }],
    });
    await expect(passed.result).resolves.toMatchObject({ status: 'answered', answeredBy: { kind: 'human' } });
  });

  it('lets the human override an agent-held persistent question and delivers it once to the delegated asker', async() => {
    // risk: concurrency — a human answer must win the durable holder CAS, wake the original asker once, and reject a stale agent answer.
    const chain = [agent('parent', 'manager', 'parent-job'), human];
    const harness = new EscalationHarness(new FixedRouteResolver(chain));
    harness.store.askerTask = { jobId: 'asker-job', taskIndex: 2, jobStatus: 'running', taskStatus: 'running', threadId: 'asker',
      parentThreadId: 'parent', parentChannel: 'chat', agentId: 'asker-agent' };
    const requested = await harness.decisions.requestQuestion({ conversationId: 'asker', channel: 'chat', title: 'Which option?',
      questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] });
    expect(requested.record.route).toMatchObject({ holderIndex: 0, chain });

    await expect(harness.decisions.resolve({ id: requested.record.id, conversationId: 'asker', action: 'answered',
      answers: [{ question: 'Which?', selected: ['A'] }] }, { kind: 'human' })).resolves.toMatchObject({ settled: true });
    const answered = (await harness.store.findById(requested.record.id))!;
    expect(answered).toMatchObject({ status: 'answered', answeredBy: { kind: 'human' }, answerDelivery: 'delivered', answers: [{ question: 'Which?', selected: ['A'] }] });
    expect(answered.route?.history).toEqual([expect.objectContaining({ threadId: 'root-chat', agentId: 'human', action: 'answered' })]);
    expect(harness.store.settleCalls).toEqual([{ id: requested.record.id, actor: { kind: 'human' }, status: 'answered' }]);
    expect(harness.askerMessages).toEqual([{ jobId: 'asker-job', taskIndex: 2,
      message: '[Decision answered by your human]\nWhich option?\nWhich?: A' }]);

    await expect(harness.decisions.answerAsAgent('parent', requested.record.id, 'answer', [{ question: 'Which?', selected: ['B'] }]))
      .resolves.toMatchObject({ settled: false });
    expect(harness.askerMessages).toHaveLength(1);
    expect(harness.store.settleCalls).toHaveLength(1);
  });

  it('keeps the existing inbox settlement path after a question reaches the human level', async() => {
    // risk: compatibility — escalation must not change the existing durable inbox path once the human already holds the question.
    const chain = [agent('parent', 'manager', 'parent-job'), human];
    const harness = new EscalationHarness(new FixedRouteResolver(chain));
    const requested = await harness.decisions.requestQuestion({ conversationId: 'asker', channel: 'chat', title: 'Which option?',
      questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] });
    await harness.escalation.advance(requested.record.id, 'passed', { kind: 'agent', threadId: 'parent', agentId: 'manager' });

    await expect(harness.decisions.resolve({ id: requested.record.id, conversationId: 'asker', action: 'answered',
      answers: [{ question: 'Which?', selected: ['B'] }] }, { kind: 'human' })).resolves.toMatchObject({ settled: true, late: true });
    expect((await harness.store.findById(requested.record.id))?.route).toMatchObject({ holderIndex: 1 });
    expect(harness.store.settleCalls).toEqual([]);
    expect(harness.store.lateChatAnswers).toHaveLength(1);
    expect(harness.chatAnswerWakes).toEqual([{ channel: 'chat', type: 'decision_answer_queued' }]);
  });

  it('answers a legacy inbox question with no route through the existing chat path', async() => {
    // risk: compatibility — questions saved before routing was introduced must remain answerable without acquiring a synthetic route.
    const harness = new EscalationHarness(new FixedRouteResolver([human]));
    const legacy: DecisionRecord = { id: 'legacy-question', conversationId: 'legacy-asker', channel: 'chat', title: 'Which option?', kind: 'question',
      status: 'pending', attention: 'active', createdAt: 1, expiresAt: 1_000_000,
      payload: { answerRoute: 'inbox' }, questions: [{ question: 'Which?', options: [{ label: 'A' }] }] };
    harness.store.put(legacy);

    await expect(harness.decisions.resolve({ id: legacy.id, conversationId: legacy.conversationId, action: 'answered',
      answers: [{ question: 'Which?', selected: ['A'] }] }, { kind: 'human' })).resolves.toMatchObject({ settled: true, late: true });
    expect((await harness.store.findById(legacy.id))?.route).toBeUndefined();
    expect(harness.store.lateChatAnswers).toHaveLength(1);
    expect(harness.chatAnswerWakes).toEqual([{ channel: 'chat', type: 'decision_answer_queued' }]);
  });

  it('authorizes the new holder after a timeout using the persisted route, not the waiter snapshot', async() => {
    // risk: availability — a parent who receives the question after escalation must still be able to settle the shared in-memory wait.
    const chain = [agent('parent', 'manager', 'parent-job'), agent('root-chat', 'root-agent'), human];
    const harness = new EscalationHarness(new FixedRouteResolver(chain));
    const requested = await harness.askQuestion();
    const parentRoute = (await harness.store.findById(requested.record.id))!.route!;
    harness.now = parentRoute.holderDeadline!;
    await harness.escalation.reconcile();

    await expect(harness.decisions.answerAsAgent('root-chat', requested.record.id, 'answer', [{ question: 'Which?', selected: ['B'] }]))
      .resolves.toMatchObject({ settled: true });
    await expect(requested.result).resolves.toMatchObject({ status: 'answered', answeredBy: { kind: 'agent', threadId: 'root-chat' } });
  });

  it('answers a durable inbox question as the current parent and rejects a later human or agent answer', async() => {
    // risk: concurrency — first compare-and-set wins and the losing actor cannot replace or claim the saved answer.
    const chain = [agent('parent', 'manager', 'parent-job'), human];
    const harness = new EscalationHarness(new FixedRouteResolver(chain));
    const requested = await harness.decisions.requestQuestion({
      conversationId: 'asker', channel: 'chat', title: 'Which option?',
      questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }],
    });

    await expect(harness.decisions.answerAsAgent('parent', requested.record.id, 'answer', [{ question: 'Which?', selected: ['B'] }]))
      .resolves.toMatchObject({ settled: true, late: true });
    const answered = (await harness.store.findById(requested.record.id))!;
    expect(answered).toMatchObject({ attention: 'answered', answeredBy: { kind: 'agent', threadId: 'parent' }, answers: [{ selected: ['B'] }] });
    expect(answered.route?.history).toEqual([expect.objectContaining({ threadId: 'parent', agentId: 'manager', action: 'answered' })]);
    await expect(harness.decisions.resolveAs({ kind: 'human' }, {
      id: requested.record.id, conversationId: 'asker', action: 'answered', answers: [{ question: 'Which?', selected: ['A'] }],
    })).resolves.toMatchObject({ settled: false });
    await expect(harness.decisions.answerAsAgent('parent', requested.record.id, 'answer', [{ question: 'Which?', selected: ['A'] }]))
      .resolves.toMatchObject({ settled: false });
  });

  it('rejects human-only question answers and approval grants at the service authority gate', async() => {
    // risk: authorization — an agent cannot answer a consent/task question or grant an approval even if it submits a valid decision id.
    const parent = agent('parent', 'manager', 'parent-job');
    const chain = [parent, human];
    const harness = new EscalationHarness(new FixedRouteResolver(chain));
    const humanOnly = question('human-only', { authority: 'human', chain, holderIndex: 0, holderSince: 100, history: [] });
    harness.store.put(humanOnly);
    await expect(harness.decisions.answerAsAgent('parent', humanOnly.id, 'answer', [{ question: 'Which?', selected: ['A'] }])).rejects.toThrow('Agents cannot answer');
    const approval = { ...humanOnly, id: 'approval-grant', kind: 'approval' as const };
    harness.store.put(approval);
    await expect(harness.decisions.answerAsAgent('parent', approval.id, 'approve' as any)).rejects.toThrow('Agents cannot approve');
  });
});

// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { randomUUID } from 'crypto';

import { postgresClient } from '../database/PostgresClient';
import { PendingDecisionRepository } from '../repositories/PendingDecisionRepository';
import { HumanDecisionRepository } from '../app/Repositories/HumanDecisionRepository';
import { ToolApprovalPolicyRepository } from '../app/Repositories/ToolApprovalPolicyRepository';
import { ConversationHistoryModel } from '../database/models/ConversationHistoryModel';
import { getWebSocketClientService } from './WebSocketClientService';
import { LateDecisionAnswerHandler } from './LateDecisionAnswerHandler';
import { LazyLateAnswerMessageSender } from './LazyLateAnswerMessageSender';
import { DecisionAuthorityPolicy } from './DecisionAuthorityPolicy';
import { DecisionRouteResolver } from './DecisionRouteResolver';
import { DecisionAskerWaiter, type DecisionQuestionAskerWaiter } from './DecisionAskerWaiter';
import { DecisionEscalationService } from './DecisionEscalationService';
import { DecisionHolderNotifier } from './DecisionHolderNotifier';
import type { DecisionAgentAction, DecisionRouteHistoryEntry } from '@pkg/shared/decisions';
import type { DecisionSettlementStatus, DecisionTransitionActor } from '../repositories/DecisionRouteTransitionSqlBuilder';
import type { AgentJobTaskTarget } from '../database/models/AgentJobMessagingModel';

import type { DecisionActor, DecisionOutcome, DecisionRecord, DecisionResponse } from '@pkg/shared/decisions';

/** Durable human requests retain their context after execution waiters expire.
 * Late question answers enter the original chat mailbox; expired approvals fail closed.
 * No tool arguments or credentials are copied into cloud snapshots.
 */
export class DecisionService {
  private readonly pendingDecisions: PendingDecisionRepository;
  private readonly lateAnswerHandler: LateDecisionAnswerHandler;
  private readonly decisions: HumanDecisionRepository;
  private readonly approvalPolicies: ToolApprovalPolicyRepository;
  private readonly authorityPolicy: DecisionAuthorityPolicy;
  private readonly routeResolver: DecisionRouteResolver;
  private readonly askerWaiter: DecisionQuestionAskerWaiter;
  private readonly escalation: Pick<DecisionEscalationService, 'start' | 'reconcile' | 'answerAsAgent' | 'authorize' | 'passFromResolveAs' | 'historyForAction'>;

  constructor(
    lateAnswerHandler?: LateDecisionAnswerHandler,
    repositories: {
      decisions?: HumanDecisionRepository;
      approvalPolicies?: ToolApprovalPolicyRepository;
      pendingDecisions?: PendingDecisionRepository;
      authorityPolicy?: DecisionAuthorityPolicy;
      routeResolver?: DecisionRouteResolver;
      askerWaiter?: DecisionQuestionAskerWaiter;
      escalation?: DecisionService['escalation'];
      holderNotifier?: DecisionHolderNotifier;
    } = {},
  ) {
    this.pendingDecisions = repositories.pendingDecisions ?? new PendingDecisionRepository(postgresClient);
    this.decisions = repositories.decisions ?? new HumanDecisionRepository(postgresClient);
    this.approvalPolicies = repositories.approvalPolicies ?? new ToolApprovalPolicyRepository(postgresClient);
    this.authorityPolicy = repositories.authorityPolicy ?? new DecisionAuthorityPolicy();
    this.routeResolver = repositories.routeResolver ?? new DecisionRouteResolver(this.pendingDecisions);
    this.askerWaiter = repositories.askerWaiter ?? new DecisionAskerWaiter();
    this.lateAnswerHandler = lateAnswerHandler ?? new LateDecisionAnswerHandler(
      this.pendingDecisions,
      { find: conversationId => this.pendingDecisions.findConversation(conversationId) },
      new LazyLateAnswerMessageSender(() => getWebSocketClientService()),
    );
    this.escalation = repositories.escalation ?? new DecisionEscalationService({
      findById: id => this.pendingDecisions.findById(id),
      openRoutedQuestions: async() => await this.pendingDecisions.openRoutedQuestions?.() ?? [],
      claimHolder: (id, index, actor, patch) => this.pendingDecisions.claimHolder(id, index, actor, patch),
      advanceHolder: (id, index, actor, patch, history, deadlineNow) => this.pendingDecisions.advanceHolder(id, index, actor, patch, history, deadlineNow),
      settleAs: (id, index, actor, status, patch, history) => this.pendingDecisions.settleAs(id, index, actor, status, patch, history),
    }, this.routeResolver, this.authorityPolicy, repositories.holderNotifier ?? new DecisionHolderNotifier(),
    (actor, response) => this.resolveAs(actor, response), record => this.changed(record));
  }
  private readonly session = randomUUID();
  private readonly listeners = new Set<(record: DecisionRecord) => void>();
  subscribe(listener: (record: DecisionRecord) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private changed(record: DecisionRecord): void {
    const entry = this.waiting.get(record.id);
    if (entry) entry.record = record;
    for (const listener of this.listeners) { try { listener(record) } catch { /* persistence remains authoritative */ } }
  }
  private readonly waiting = new Map<string, {
    record:  DecisionRecord;
    settle:  (outcome: DecisionOutcome) => void;
    timer:   ReturnType<typeof setTimeout>;
    busy:    boolean;
    cleanup: () => void;
  }>();

  private questionWrites = Promise.resolve();

  private async parkQuestionAsker(asker: AgentJobTaskTarget | null | undefined, decisionId: string): Promise<boolean> {
    if (!asker || !['running', 'parked'].includes(asker.jobStatus) || !['running', 'parked'].includes(asker.taskStatus)) return false;
    try { await this.askerWaiter.park(asker.jobId, asker.taskIndex, decisionId); return true }
    catch (error) { console.warn('[DecisionService] Could not park asker for question:', error); return false }
  }

  /** Human questions outlive tool transports; answers always use the durable mailbox. */
  requestQuestion(input: Pick<DecisionRecord, 'conversationId' | 'channel' | 'title' | 'questions'> & Partial<Pick<DecisionRecord, 'payload'>>, signal?: AbortSignal): Promise<{ record: DecisionRecord; reused: boolean; parked?: boolean }> {
    const operation = this.questionWrites.then(async() => {
      if (signal?.aborted) throw new Error('Request cancelled');
      if (!input.conversationId || !input.channel || !input.questions?.length) throw new Error('A question requires its original conversation and options.');
      const asker = await this.pendingDecisions.taskForThread?.(input.conversationId);
      const existing = await this.pendingDecisions.findOpenQuestion(input);
      if (existing) {
        const parked = existing.attention !== 'answered' && await this.parkQuestionAsker(asker, existing.id);
        let current = existing;
        if (existing.kind === 'question' && existing.route?.authority === 'any' && existing.route.chain[existing.route.holderIndex]?.kind === 'agent') {
          await this.escalation.start(existing);
          current = await this.pendingDecisions.findById(existing.id) ?? existing;
        }
        this.changed(current);
        return { record: current, reused: true, ...(parked ? { parked: true } : {}) };
      }
      const relatedConversationIds = await this.pendingDecisions.ancestry(input.conversationId);
      if (signal?.aborted) throw new Error('Request cancelled');
      const now = Date.now();
      const candidate = { ...input, kind: 'question' as const };
      const chain = await this.routeResolver.resolve(input.conversationId, input.channel);
      const authority = this.authorityPolicy.classify(candidate);
      const route = { authority, chain, holderIndex: authority === 'human' ? chain.length - 1 : 0, holderSince: now, history: [] };
      const record: DecisionRecord = {
        ...input,
        ...(asker ? { requestedBy: { agentId: asker.agentId || asker.label || 'agent', label: asker.label, jobId: asker.jobId, taskIndex: asker.taskIndex } } : {}),
        relatedConversationIds,
        route,
        kind: 'question', id: randomUUID(), status: 'pending', attention: 'active', createdAt: now,
        expiresAt: now + 30 * 60_000, payload: {
          ...input.payload,
          ...(asker ? { askerJobId: asker.jobId, askerTaskIndex: String(asker.taskIndex) } : {}),
          answerRoute: 'inbox',
        },
      };
      await this.decisions.insert(record, this.session);
      const parked = await this.parkQuestionAsker(asker, record.id);
      let current = record;
      if (record.route?.authority === 'any' && record.route.chain[record.route.holderIndex]?.kind === 'agent') {
        await this.escalation.start(record);
        current = await this.pendingDecisions.findById(record.id) ?? record;
      }
      this.changed(current);
      return { record: current, reused: false, ...(parked ? { parked: true } : {}) };
    });
    this.questionWrites = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async request(input: Omit<DecisionRecord, 'id' | 'status' | 'createdAt' | 'expiresAt'>, timeoutMs = 30 * 60_000, signal?: AbortSignal) {
    if (signal?.aborted) throw new Error('Request cancelled');
    if (!input.conversationId || !input.channel) throw new Error('Approval requires the original conversation. No action was executed.');
    const now = Date.now();
    const relatedConversationIds = await this.pendingDecisions.ancestry(input.conversationId);
    const chain = await this.routeResolver.resolve(input.conversationId, input.channel);
    const authority = this.authorityPolicy.classify(input);
    const record: DecisionRecord = {
      ...input, relatedConversationIds,
      route: { authority, chain, holderIndex: authority === 'human' ? chain.length - 1 : 0, holderSince: now, history: [] },
      id: randomUUID(), status: 'pending', attention: 'active', createdAt: now, expiresAt: now + timeoutMs,
    };
    await this.decisions.insert(record, this.session);
    let settle!: (value: DecisionOutcome) => void;
    const result = new Promise<DecisionOutcome>(resolve => { settle = resolve });
    const timer = setTimeout(() => { this.expire(record.id) }, timeoutMs);
    timer.unref?.();
    const abort = () => { this.expire(record.id) };
    this.waiting.set(record.id, { record, settle, timer, busy: false, cleanup: () => signal?.removeEventListener('abort', abort) });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    else this.changed(record);
    return { record, result };
  }

  async listForConversation(conversationId: string, before?: { at: number; id: string }): Promise<DecisionRecord[]> {
    if (!conversationId || conversationId.length > 300) throw new Error('A conversation is required.');
    await this.reconcileExpired();
    await this.pendingDecisions.preserveAncestry(conversationId);
    return this.pendingDecisions.listForConversation(conversationId, before);
  }

  async listTranscriptDecisions(conversationId: string, ids: string[]): Promise<DecisionRecord[]> {
    if (typeof conversationId !== 'string' || !conversationId || conversationId.length > 300 ||
        !Array.isArray(ids) || ids.length > 500 || ids.some(id => typeof id !== 'string' || !id || id.length > 300)) {
      throw new Error('A conversation and valid request IDs are required.');
    }
    return this.pendingDecisions.listTranscriptDecisions(conversationId, ids);
  }

  async dismiss(id: string, conversationId: string): Promise<{ settled: boolean }> {
    const entry = this.waiting.get(id);
    if (entry?.busy) return { settled: false };
    if (entry) entry.busy = true;
    try {
      const record = await this.pendingDecisions.dismiss(id, conversationId);
      if (!record) return { settled: false };
      if (entry) entry.record = record;
      this.changed(record);
      return { settled: true };
    } finally { if (entry) entry.busy = false; }
  }

  /** Expire overdue requests and announce each one, so Files and the asker hear about it. */
  async reconcileExpired(): Promise<void> {
    for (const record of await this.pendingDecisions.expireOpenDecisions(this.session, Date.now())) this.changed(record);
    await this.escalation.reconcile();
  }

  async pendingAnswerTargets(locallyOwnedThreads: string[] = []) {
    for (const record of await this.pendingDecisions.recoverInterruptedAnswers(locallyOwnedThreads)) this.changed(record);
    return this.pendingDecisions.pendingAnswerTargets();
  }

  async startAnswers(inputs: { id: string; attempt: string }[], conversationId: string): Promise<string[]> { return this.pendingDecisions.startAnswers(inputs, conversationId) }
  async finishAnswers(inputs: { id: string; attempt: string }[], conversationId: string, completed: boolean): Promise<void> {
    for (const record of await this.pendingDecisions.finishAnswers(inputs, conversationId, completed)) this.changed(record);
  }

  async find(id: string): Promise<DecisionRecord | undefined> { return this.pendingDecisions.findById(id) }

  async pendingApprovalForPayload(key: string, value: string): Promise<DecisionRecord | undefined> {
    return this.pendingDecisions.findApproval(this.session, key, value, Date.now());
  }

  async list(): Promise<DecisionRecord[]> {
    await this.reconcileExpired();
    return this.decisions.listRecent();
  }

  async resolve(response: DecisionResponse, actor: DecisionActor): Promise<{ settled: boolean; conversationId?: string; reason?: string; late?: boolean; closed?: boolean }> {
    return this.resolveAs(actor, response);
  }

  async answerAsAgent(threadId: string, decisionId: string, action: DecisionAgentAction, answers?: DecisionResponse['answers'], note?: string) {
    return this.escalation.answerAsAgent(threadId, decisionId, action, answers, note);
  }

  async resolveAs(actor: DecisionActor, response: DecisionResponse): Promise<{ settled: boolean; conversationId?: string; reason?: string; late?: boolean; closed?: boolean }> {
    if (!actor || !['human', 'agent'].includes(actor.kind)) throw new Error('A decision actor is required.');
    if (!response || typeof response.id !== 'string' || typeof response.conversationId !== 'string') return { settled: false, reason: 'Request and conversation are required.' };
    const entry = this.waiting.get(response.id);
    const record = actor.kind === 'agent' || !entry
      ? await this.pendingDecisions.findById?.(response.id) ?? entry?.record
      : entry.record;
    if (!record || record.conversationId !== response.conversationId) return { settled: false, reason: 'Request is no longer waiting.' };
    if (entry) entry.record = record;
    const agentHolder = record.kind === 'question' && record.route?.authority === 'any' && record.route.chain[record.route.holderIndex]?.kind === 'agent';
    if (record.kind === 'question' && record.attention === 'answered') return { settled: false, reason: 'This question was already answered.' };
    const agentAction: DecisionAgentAction | undefined = response.action === 'answered' ? 'answer' : response.action === 'denied' ? 'deny'
      : response.action === 'passed' ? 'pass' : response.action === 'approved' ? 'approve' : response.action === 'deferred' ? 'pass' : undefined;
    if (actor.kind === 'agent' && (!agentHolder || !agentAction || !await this.escalation.authorize(record, actor, agentAction))) {
      return { settled: false, reason: 'Only the authorized holder may take that action.' };
    }
    if (!entry && actor.kind === 'human' && agentHolder && response.action === 'answered') {
      return this.escalation.answerAsHuman(record, response, answered => this.lateAnswerHandler.handle(answered, response));
    }
    if (response.action === 'passed') {
      if (entry?.busy) return { settled: false, reason: 'Already answered or unavailable.' };
      if (entry) entry.busy = true;
      try {
        if (actor.kind !== 'agent' || !agentHolder || !await this.escalation.passFromResolveAs(record, actor, response.note)) return { settled: false, reason: 'Decision is no longer held by this agent.' };
        const updated = await this.pendingDecisions.findById?.(record.id);
        if (updated) { if (entry) entry.record = updated; this.changed(updated) }
        return { settled: true, conversationId: record.conversationId };
      } finally { if (entry) entry.busy = false }
    }
    if (!entry) {
      if (record.kind === 'question' && (record.status === 'expired' || record.payload?.answerRoute === 'inbox') && response.action === 'answered') {
        const receipt = await this.lateAnswerHandler.handle({ ...record, answeredBy: actor }, response);
        const updated = await this.pendingDecisions.findById(record.id);
        if (updated) this.changed(updated);
        return receipt;
      }
      // A Files publish approval has no blocked tool waiting on it, so it stays decidable after an app restart.
      if (record.kind === 'approval' && actor.kind === 'human' && record.payload?.filesPublishRequestId && ['pending', 'deferred'].includes(record.status)) {
        if (!['approved', 'denied', 'deferred'].includes(response.action)) throw new Error('Choose approve or deny');
        const now = Date.now();
        if (now >= record.expiresAt) {
          await this.reconcileExpired();
          return { settled: false, reason: 'This request expired. Ask for a fresh request in the original conversation.' };
        }
        const next: DecisionRecord = {
          ...record,
          status: response.action,
          answeredBy: actor,
          ...(response.action !== 'deferred' ? { attention: 'answered' } : {}),
        };
        if (!await this.decisions.settleDurablePublish(response.id, response.action, next, now)) return { settled: false, reason: 'Request is no longer pending.' };
        this.changed(next);
        return { settled: true, conversationId: next.conversationId };
      }
      return { settled: false, reason: 'Request is no longer waiting.' };
    }
    if (entry.busy) {
      return { settled: false, reason: 'Already answered, unavailable, or not this conversation.' };
    }
    entry.busy = true;
    try {
      if (Date.now() >= entry.record.expiresAt) {
        entry.busy = false;
        await this.expire(response.id);
      const expired = entry.record;
      if (expired?.kind === 'question' && expired.status === 'expired' && response.action === 'answered') {
        const receipt = await this.lateAnswerHandler.handle({ ...expired, answeredBy: actor }, response);
        const updated = await this.pendingDecisions.findById?.(expired.id);
        if (updated) this.changed(updated);
        return receipt;
      }
      return { settled: false, reason: 'This request expired. Ask for a fresh request in the original conversation.' };
      }
      const action = response.action;
      if (!['approved', 'denied', 'answered', 'deferred'].includes(action)) throw new Error('Invalid decision');
      if (entry.record.kind === 'question' && !['answered', 'deferred'].includes(action)) throw new Error('Answer the questions');
      if (entry.record.kind === 'approval' && action === 'answered') throw new Error('Choose approve or deny');
      let answers: DecisionOutcome['answers'] = [];
      if (action === 'answered') {
        const questions = entry.record.questions ?? [];
        if (!Array.isArray(response.answers) || response.answers.length !== questions.length) throw new Error('Answer every question');
        answers = questions.map((q, i) => {
          const selected = response.answers![i]?.selected;
          if (!Array.isArray(selected) || !selected.length || (!q.multiSelect && selected.length !== 1) || selected.some(s => typeof s !== 'string' || !s.trim() || s.length > 10000)) throw new Error('Answer could not be recorded.');
          return { question: q.question, selected: selected.map(s => s.trim()) };
        });
      }
      const routeHistory = action === 'deferred' || !entry.record.route ? []
        : this.escalation.historyForAction(entry.record, actor, action, response.note);
      const next: DecisionRecord = {
        ...entry.record, status: action,
        ...(action !== 'deferred' ? { attention: 'answered' as const, answeredBy: actor } : {}),
        ...(answers.length ? { answers } : {}),
        ...(routeHistory.length && entry.record.route ? { route: { ...entry.record.route, history: [...entry.record.route.history, ...routeHistory] } } : {}),
      };
      const { route: _route, ...patch } = next;
      const settled = agentHolder
        ? await this.pendingDecisions.settleAs(response.id, record.route!.holderIndex, actor, action as DecisionSettlementStatus, patch, routeHistory)
        : actor.kind === 'human' && await this.decisions.settle(response.id, action, next, this.session);
      if (!settled) return { settled: false, reason: 'Request is no longer pending.' };
      entry.record = agentHolder ? await this.pendingDecisions.findById?.(response.id) ?? next : next;
      this.changed(entry.record);
      if (action !== 'deferred') {
        entry.cleanup();
        clearTimeout(entry.timer);
        this.waiting.delete(response.id);
        entry.settle({ status: action, answers, answeredBy: actor, ...(actor.note ? { note: actor.note } : {}) });
      }
      return { settled: true, conversationId: entry.record.conversationId };
    } finally { entry.busy = false }
  }

  async expire(id: string): Promise<void> {
    const entry = this.waiting.get(id);
    if (!entry) return;
    if (entry.busy) {
      entry.timer = setTimeout(() => { this.expire(id) }, 100);
      entry.timer.unref?.();
      return;
    }
    entry.busy = true;
    try {
      let result: DecisionRecord; let expiredNow = false;
      if (entry.record.kind === 'question' && entry.record.route?.authority === 'any' && entry.record.route.chain[entry.record.route.holderIndex]?.kind === 'agent') {
        const route = entry.record.route!;
        expiredNow = await this.pendingDecisions.settleAs(id, route.holderIndex, { kind: 'system', threadId: route.chain[route.holderIndex]?.threadId ?? entry.record.conversationId }, 'expired', { status: 'expired' }, []);
        const current = await this.pendingDecisions.findById?.(id);
        if (!expiredNow && current && !['approved', 'denied', 'answered', 'expired'].includes(current.status)) return;
        result = current ?? { ...entry.record, status: 'expired' };
      } else {
        const expired = await this.decisions.expirePending(id);
        if (expired) { result = expired; expiredNow = true; } else {
          const current = await this.pendingDecisions.findById?.(id);
          if (current && !['approved', 'denied', 'answered', 'expired'].includes(current.status)) return;
          result = current ?? { ...entry.record, status: 'expired' };
        }
      }
      this.waiting.delete(id);
      clearTimeout(entry.timer);
      entry.cleanup();
      entry.record = result;
      entry.settle({ status: result.status, answers: result.answers ?? [], answeredBy: result.answeredBy, ...(result.answeredBy?.note ? { note: result.answeredBy.note } : {}) });
      if (expiredNow) this.changed(result);
    } catch { /* Keep the waiter available; the durable sweep retries after database recovery. */ }
    finally { entry.busy = false }
  }

  async requiresApproval(toolName: string): Promise<boolean> {
    return this.approvalPolicies.exists(toolName);
  }

  async policies(): Promise<string[]> {
    return this.approvalPolicies.listToolNames();
  }

  async setPolicy(toolName: string, required: boolean): Promise<void> {
    if (required) await this.approvalPolicies.add(toolName);
    else await this.approvalPolicies.remove(toolName);
  }
}
export const decisionService = new DecisionService();

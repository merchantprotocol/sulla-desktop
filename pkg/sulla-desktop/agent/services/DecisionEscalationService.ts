// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { DecisionActor, DecisionAgentAction, DecisionRecord, DecisionResponse, DecisionRouteEntry, DecisionRouteHistoryEntry } from '@pkg/shared/decisions';
import type { DecisionAuthorityPolicy } from './DecisionAuthorityPolicy';
import type { DecisionRouteResolver } from './DecisionRouteResolver';
import type { DecisionHolderNotifier } from './DecisionHolderNotifier';
import type { DecisionRoutePatch, DecisionTransitionActor } from '../repositories/DecisionRouteTransitionSqlBuilder';

export interface DecisionEscalationRepository {
  findById(id: string): Promise<DecisionRecord | undefined>;
  openRoutedQuestions(): Promise<DecisionRecord[]>;
  claimHolder(id: string, expectedIndex: number, actor: DecisionTransitionActor, patch: DecisionRoutePatch): Promise<boolean>;
  advanceHolder(id: string, expectedIndex: number, actor: DecisionTransitionActor, patch: DecisionRoutePatch,
    history: DecisionRouteHistoryEntry, deadlineNow?: number): Promise<boolean>;
  settleAs(id: string, expectedIndex: number, actor: DecisionTransitionActor, status: 'denied' | 'answered',
    patch: Partial<Omit<DecisionRecord, 'route'>>, history: DecisionRouteHistoryEntry[]): Promise<boolean>;
}

export interface DecisionResolveAs { (actor: DecisionActor, response: DecisionResponse): Promise<{ settled: boolean; conversationId?: string; reason?: string; late?: boolean; closed?: boolean }> }

/** Owns holder transitions; DecisionService remains the single settlement/waiter authority. */
export class DecisionEscalationService {
  static readonly DELIVERY_WINDOW_MS = 3 * 60_000;
  static readonly LEVEL_CAP_MS = 5 * 60_000;
  private hasReconciled = false;
  private readonly delivering = new Set<string>();

  constructor(
    private readonly records: DecisionEscalationRepository,
    private readonly routes: DecisionRouteResolver,
    private readonly authority: DecisionAuthorityPolicy,
    private readonly notifier: DecisionHolderNotifier,
    private readonly resolveAs: DecisionResolveAs,
    private readonly changed: (record: DecisionRecord) => void = () => undefined,
    private readonly clock: () => number = Date.now,
  ) {}

  async start(record: DecisionRecord): Promise<void> {
    if (record.kind !== 'question' || record.route?.authority !== 'any' || record.route.deliveredAt != null) return;
    await this.deliverCurrent(record);
  }

  async answerAsAgent(threadId: string, decisionId: string, action: DecisionAgentAction, answers?: DecisionResponse['answers'], note?: string) {
    const record = await this.records.findById(decisionId);
    if (!record) return { settled: false, reason: 'Decision not found.' };
    if (!this.authority.allows(record, action, 'agent')) throw new Error(`Agents cannot ${ action } this decision.`);
    const holder = this.currentAgentHolder(record, threadId);
    if (!holder) return { settled: false, reason: 'Only the current holder can act on this decision.' };
    if (await this.routes.liveness(holder, record.conversationId) !== 'available' || !await this.notifier.canAnswer(record, holder)) {
      await this.advance(decisionId, 'unavailable');
      return { settled: false, reason: 'This holder is no longer available; the decision was passed up.' };
    }
    const actor: DecisionActor = { kind: 'agent', threadId, agentId: holder.agentId, label: holder.label || holder.agentId, ...(action === 'deny' && note ? { note: note.slice(0, 500) } : {}) };
    const response: DecisionResponse = {
      id: record.id,
      conversationId: record.conversationId,
      action: action === 'answer' ? 'answered' : action === 'deny' ? 'denied' : 'passed',
      ...(answers ? { answers } : {}),
      ...(note ? { note: note.slice(0, 500) } : {}),
    };
    return this.resolveAs(actor, response);
  }

  async answerAsHuman(record: DecisionRecord, response: DecisionResponse,
    deliver: (record: DecisionRecord) => Promise<{ settled: boolean; conversationId?: string; reason?: string; late?: boolean; closed?: boolean }>) {
    const route = record.route;
    if (response.action !== 'answered' || record.kind !== 'question' || route?.authority !== 'any' || route.chain[route.holderIndex]?.kind !== 'agent') {
      return { settled: false, reason: 'This question is no longer held by an agent.' };
    }
    const questions = record.questions ?? [];
    if (!Array.isArray(response.answers) || response.answers.length !== questions.length) throw new Error('Answer every question');
    const answers = questions.map((question, index) => {
      const selected = response.answers![index]?.selected;
      if (!Array.isArray(selected) || !selected.length || (!question.multiSelect && selected.length !== 1) ||
        selected.some(value => typeof value !== 'string' || !value.trim() || value.length > 10000)) throw new Error('Answer could not be recorded.');
      return { question: question.question, selected: selected.map(value => value.trim()) };
    });
    const actor: DecisionActor = { kind: 'human' };
    const history = this.historyForAction(record, actor, 'answered', response.note);
    const patch: Partial<Omit<DecisionRecord, 'route'>> = { status: 'answered', attention: 'answered', answeredBy: actor, answers };
    if (!await this.records.settleAs(record.id, route.holderIndex, actor, 'answered', patch, history)) {
      return { settled: false, reason: 'This question was already answered or dismissed.' };
    }
    const answered = await this.records.findById(record.id) ?? { ...record, ...patch, route: { ...route, history: [...route.history, ...history] } };
    this.changed(answered);
    const receipt = await deliver(answered);
    return { ...receipt, settled: receipt.settled, conversationId: answered.conversationId };
  }

  pass(threadId: string, decisionId: string, note?: string) { return this.answerAsAgent(threadId, decisionId, 'pass', undefined, note) }
  denyAsAgent(threadId: string, decisionId: string, note?: string) { return this.answerAsAgent(threadId, decisionId, 'deny', undefined, note) }

  async authorize(record: DecisionRecord, actor: DecisionActor, action: DecisionAgentAction): Promise<boolean> {
    if (actor.kind !== 'agent' || !actor.threadId || !this.authority.allows(record, action, 'agent')) return false;
    const holder = this.currentAgentHolder(record, actor.threadId);
    if (!holder) return false;
    if (await this.routes.liveness(holder, record.conversationId) !== 'available' || !await this.notifier.canAnswer(record, holder)) {
      await this.advance(record.id, 'unavailable');
      return false;
    }
    return true;
  }

  async advance(decisionId: string, reason: 'timeout' | 'unavailable' | 'passed', actor?: DecisionActor, note?: string): Promise<boolean> {
    const record = await this.records.findById(decisionId);
    const route = record?.route;
    if (!record || !route || route.holderIndex >= route.chain.length - 1) return false;
    const holder = route.chain[route.holderIndex];
    if (holder.kind !== 'agent') return false;
    const now = this.clock();
    if (reason === 'timeout' && (route.holderDeadline == null || route.holderDeadline > now)) return false;
    if (reason === 'passed' && (!actor || actor.kind !== 'agent' || actor.threadId !== holder.threadId)) return false;
    const action = reason === 'passed' ? 'passed' : reason;
    const history = this.history(holder, action, now, note ?? actor?.note);
    const next = Math.min(route.holderIndex + 1, route.chain.length - 1);
    const patch: DecisionRoutePatch = { holderIndex: next, holderSince: now, holderDeadline: null, deliveredAt: null };
    const transitionActor: DecisionTransitionActor = reason === 'passed'
      ? actor as DecisionActor
      : { kind: 'system', threadId: holder.threadId };
    const advanced = await this.records.advanceHolder(record.id, route.holderIndex, transitionActor, patch, history, reason === 'timeout' ? now : undefined);
    if (!advanced) return false;
    const updated = await this.records.findById(record.id);
    if (updated) { this.changed(updated); await this.deliverCurrent(updated) }
    return true;
  }

  async passFromResolveAs(record: DecisionRecord, actor: DecisionActor, note?: string): Promise<boolean> {
    return this.advance(record.id, 'passed', actor, note);
  }

  historyForAction(record: DecisionRecord, actor: DecisionActor, action: DecisionResponse['action'], note?: string): DecisionRouteHistoryEntry[] {
    if (!record.route) return [];
    const holder = record.route.chain[record.route.holderIndex];
    const transition: DecisionRouteHistoryEntry['action'] = action === 'approved' ? 'approved' : action === 'denied' ? 'denied'
      : action === 'deferred' ? 'deferred' : 'answered';
    return [{ threadId: actor.kind === 'agent' ? actor.threadId || holder?.threadId || record.conversationId : record.route.chain.at(-1)?.threadId || record.conversationId,
      agentId: actor.kind === 'agent' ? actor.agentId || 'agent' : 'human', action: transition, at: this.clock(),
      ...((note ?? actor.note) ? { note: (note ?? actor.note)!.slice(0, 500) } : {}) }];
  }

  async reconcile(): Promise<void> {
    const startup = !this.hasReconciled;
    const records = await this.records.openRoutedQuestions();
    for (const record of records) {
      const route = record.route;
      if (!route || route.holderIndex >= route.chain.length - 1) continue;
      const holder = route.chain[route.holderIndex];
      if (holder.kind !== 'agent') continue;
      const now = this.clock();
      if (route.holderDeadline != null && route.holderDeadline <= now) await this.advance(record.id, 'timeout');
      else if (await this.routes.liveness(holder, record.conversationId) !== 'available' || !await this.notifier.canAnswer(record, holder)) await this.advance(record.id, 'unavailable');
      else if (route.deliveredAt == null) await this.deliverCurrent(record);
      else if (startup && !holder.jobId) await this.redeliverCurrent(record);
    }
    this.hasReconciled = true;
  }

  private async deliverCurrent(record: DecisionRecord): Promise<void> {
    const current = await this.records.findById(record.id) ?? record;
    const route = current.route;
    if (!route || route.deliveredAt != null || route.holderIndex >= route.chain.length - 1) return;
    const holder = route.chain[route.holderIndex];
    if (holder.kind !== 'agent') return;
    const key = `${ current.id }:${ route.holderIndex }`;
    if (this.delivering.has(key)) return;
    this.delivering.add(key);
    try {
      let available = false;
      try {
        available = await this.routes.liveness(holder, current.conversationId) === 'available' && await this.notifier.canAnswer(current, holder);
      } catch { /* An untrustworthy notifier cannot hold a decision indefinitely. */ }
      if (!available) {
        await this.advance(current.id, 'unavailable');
        return;
      }

      // Start the holder's clock before sending. A job wake can dispatch a
      // complete agent turn, so awaiting delivery here would leave no deadline
      // while that turn runs (and can deadlock if it asks a follow-up question).
      const deliveredAt = this.clock();
      const holderDeadline = Math.min(deliveredAt + DecisionEscalationService.DELIVERY_WINDOW_MS,
        route.holderSince + DecisionEscalationService.LEVEL_CAP_MS);
      if (!await this.records.claimHolder(current.id, route.holderIndex, { kind: 'system', threadId: holder.threadId }, { deliveredAt, holderDeadline })) return;

      let delivered = false;
      try {
        const claimed = await this.records.findById(current.id) ?? { ...current, route: { ...route, deliveredAt, holderDeadline } };
        delivered = await this.notifier.deliver(claimed, holder);
      } catch { /* A failed delivery advances rather than holding this holder forever. */ }
      if (!delivered) {
        await this.advance(current.id, 'unavailable');
        return;
      }

      const updated = await this.records.findById(current.id);
      if (updated) this.changed(updated);
    } finally { this.delivering.delete(key) }
  }

  private async redeliverCurrent(record: DecisionRecord): Promise<void> {
    const current = await this.records.findById(record.id) ?? record;
    const route = current.route;
    if (!route || route.deliveredAt == null || route.holderIndex >= route.chain.length - 1) return;
    const holder = route.chain[route.holderIndex];
    if (holder.kind !== 'agent') return;
    const key = `${ current.id }:${ route.holderIndex }`;
    if (this.delivering.has(key)) return;
    this.delivering.add(key);
    try {
      if (await this.routes.liveness(holder, current.conversationId) !== 'available' || !await this.notifier.canAnswer(current, holder) ||
          !await this.notifier.deliver(current, holder)) await this.advance(current.id, 'unavailable');
    } finally { this.delivering.delete(key) }
  }

  private currentAgentHolder(record: DecisionRecord, threadId: string): DecisionRouteEntry | undefined {
    const route = record.route;
    if (!route) return undefined;
    const holder = route.chain[route.holderIndex];
    return holder?.kind === 'agent' && holder.threadId === threadId ? holder : undefined;
  }

  private history(holder: DecisionRouteEntry, action: DecisionRouteHistoryEntry['action'], at: number, note?: string): DecisionRouteHistoryEntry {
    return { threadId: holder.threadId, agentId: holder.agentId, action, at, ...(note ? { note: note.slice(0, 500) } : {}) };
  }
}

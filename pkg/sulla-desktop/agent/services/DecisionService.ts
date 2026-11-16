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

import type { DecisionOutcome, DecisionRecord, DecisionResponse } from '@pkg/shared/decisions';

/** Durable inbox; execution stays parked in the ORIGINAL caller, never a new graph.
 * Restarted processes cannot safely replay closures: their rows expire, fail closed.
 * No tool arguments or credentials are copied into cloud snapshots.
 */
export class DecisionService {
  private readonly pendingDecisions: PendingDecisionRepository;
  private readonly lateAnswerHandler: LateDecisionAnswerHandler;
  private readonly decisions: HumanDecisionRepository;
  private readonly approvalPolicies: ToolApprovalPolicyRepository;

  constructor(
    lateAnswerHandler?: LateDecisionAnswerHandler,
    repositories: { decisions?: HumanDecisionRepository; approvalPolicies?: ToolApprovalPolicyRepository } = {},
  ) {
    this.pendingDecisions = new PendingDecisionRepository(postgresClient);
    this.decisions = repositories.decisions ?? new HumanDecisionRepository(postgresClient);
    this.approvalPolicies = repositories.approvalPolicies ?? new ToolApprovalPolicyRepository(postgresClient);
    this.lateAnswerHandler = lateAnswerHandler ?? new LateDecisionAnswerHandler(
      this.pendingDecisions,
      { find: async conversationId => (await ConversationHistoryModel.getByThread(conversationId)) ?? await ConversationHistoryModel.getById(conversationId) },
      new LazyLateAnswerMessageSender(() => getWebSocketClientService()),
    );
  }
  private readonly session = randomUUID();
  private readonly listeners = new Set<(record: DecisionRecord) => void>();
  subscribe(listener: (record: DecisionRecord) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private changed(record: DecisionRecord): void { for (const listener of this.listeners) { try { listener(record) } catch { /* persistence remains authoritative */ } } }
  private readonly waiting = new Map<string, {
    record:  DecisionRecord;
    settle:  (outcome: DecisionOutcome) => void;
    timer:   ReturnType<typeof setTimeout>;
    busy:    boolean;
    cleanup: () => void;
  }>();

  async request(input: Omit<DecisionRecord, 'id' | 'status' | 'createdAt' | 'expiresAt'>, timeoutMs = 30 * 60_000, signal?: AbortSignal) {
    if (signal?.aborted) throw new Error('Request cancelled');
    if (!input.conversationId || !input.channel) throw new Error('Approval requires the original conversation. No action was executed.');
    const now = Date.now();
    const record: DecisionRecord = { ...input, id: randomUUID(), status: 'pending', createdAt: now, expiresAt: now + timeoutMs };
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

  async pendingApprovalForPayload(key: string, value: string): Promise<DecisionRecord | undefined> {
    return this.pendingDecisions.findApproval(this.session, key, value, Date.now());
  }

  async list(): Promise<DecisionRecord[]> {
    // Rows from a previous process are evidence, never runnable requests.
    await this.decisions.expireForeignOrOverdue(this.session, Date.now());
    return this.decisions.listRecent();
  }

  async resolve(response: DecisionResponse): Promise<{ settled: boolean; conversationId?: string; reason?: string; late?: boolean; closed?: boolean }> {
    if (!response || typeof response.id !== 'string' || typeof response.conversationId !== 'string') return { settled: false, reason: 'Request and conversation are required.' };
    const entry = this.waiting.get(response.id);
    if (!entry) {
      const record = await this.pendingDecisions.findById(response.id);
      if (record?.kind === 'question' && record.status === 'expired' && response.action === 'answered' && record.conversationId === response.conversationId) return this.lateAnswerHandler.handle(record, response);
      return { settled: false, reason: 'Request is no longer waiting.' };
    }
    if (entry.record.conversationId !== response.conversationId || entry.busy) {
      return { settled: false, reason: 'Already answered, unavailable, or not this conversation.' };
    }
    if (Date.now() >= entry.record.expiresAt) {
      await this.expire(response.id);
      const expired = await this.pendingDecisions.findById(response.id);
      if (expired?.kind === 'question' && expired.status === 'expired' && response.action === 'answered') return this.lateAnswerHandler.handle(expired, response);
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
        if (!Array.isArray(selected) || !selected.length || (!q.multiSelect && selected.length !== 1) ||
          selected.some(s => typeof s !== 'string' || !s.trim() || s.length > 10000)) throw new Error('Answer could not be recorded.');
        return { question: q.question, selected: selected.map(s => s.trim()) };
      });
    }
    entry.busy = true;
    try {
      const next: DecisionRecord = { ...entry.record, status: action, ...(answers.length ? { answers } : {}) };
      if (!await this.decisions.settle(response.id, action, next, this.session)) return { settled: false, reason: 'Request is no longer pending.' };
      entry.record = next;
      this.changed(next);
      if (action !== 'deferred') {
        entry.cleanup();
        clearTimeout(entry.timer);
        this.waiting.delete(response.id);
        entry.settle({ status: action, answers });
      }
      return { settled: true, conversationId: next.conversationId };
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
    this.waiting.delete(id);
    clearTimeout(entry.timer);
    entry.cleanup();
    entry.settle({ status: 'expired', answers: [] });
    this.changed({ ...entry.record, status: 'expired' });
    try {
      await this.decisions.expirePending(id);
    } catch { /* Fail closed even if persistence is temporarily unavailable. list() reconciles below. */ }
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

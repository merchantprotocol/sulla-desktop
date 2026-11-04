// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'node:fs';
import readline from 'node:readline';
import { Service } from '@sulla/foundation';
import type { BaseThreadState } from '../../nodes/Graph';
import type { ConversationHistoryRecord } from '../../database/models/ConversationHistoryModel';

export interface ThreadStateRepository {
  save(state: BaseThreadState): Promise<void>;
  load(threadId: string): Promise<BaseThreadState | null>;
  delete(threadId: string): Promise<void>;
}
export interface RedisThreadStateClient {
  status: string;
  ping(): Promise<unknown>;
  setex(key: string, seconds: number, value: string): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
}
export interface ConversationHistoryLookup {
  getByThread(threadId: string): Promise<ConversationHistoryRecord | null>;
}
export interface ThreadStateLogger {
  log(message: string): void;
  error(message: string, ...details: unknown[]): void;
}

export class MemoryThreadStateRepository extends Service implements ThreadStateRepository {
  private readonly states = new Map<string, BaseThreadState>();
  async save(state: BaseThreadState): Promise<void> { this.states.set(state.metadata.threadId, structuredClone(state)); }
  async load(threadId: string): Promise<BaseThreadState | null> {
    const state = this.states.get(threadId);
    return null;
  }
  async delete(threadId: string): Promise<void> { this.states.delete(threadId); }
}

export class RedisThreadStateRepository extends Service implements ThreadStateRepository {
  private static readonly KEY_PREFIX = 'sulla:threadstate:';
  constructor(private readonly client: RedisThreadStateClient, private readonly ttlSeconds = 3600) { super(); }
  async available(): Promise<boolean> {
    if (this.client.status !== 'ready') return false;
    try { await this.client.ping(); return true; } catch { return false; }
  }
  async save(state: BaseThreadState): Promise<void> {
    await this.client.setex(this.key(state.metadata.threadId), this.ttlSeconds, JSON.stringify(structuredClone(state)));
  }
  async load(threadId: string): Promise<BaseThreadState | null> {
    const json = await this.client.get(this.key(threadId));
    return json ? structuredClone(JSON.parse(json) as BaseThreadState) : null;
  }
  async delete(threadId: string): Promise<void> { await this.client.del(this.key(threadId)); }
  private key(threadId: string): string { return RedisThreadStateRepository.KEY_PREFIX + threadId; }
}

export class LogRecoveryThreadStateRepository extends Service implements ThreadStateRepository {
  constructor(private readonly conversations: ConversationHistoryLookup, private readonly now: () => number = Date.now) { super(); }
  async save(_state: BaseThreadState): Promise<void> {}
  async delete(_threadId: string): Promise<void> {}
  async load(threadId: string): Promise<BaseThreadState | null> {
    const record = await this.conversations.getByThread(threadId);
    if (!record?.log_file || !fs.existsSync(record.log_file)) return null;
    const messages: BaseThreadState['messages'] = [];
    const lines = readline.createInterface({ input: fs.createReadStream(record.log_file, { encoding: 'utf-8' }), crlfDelay: Infinity });
    for await (const line of lines) {
      const event = this.parseEvent(line);
      if (event) messages.push({
        role: event.role, content: event.content,
        metadata: { timestamp: event.ts ? new Date(event.ts).getTime() : this.now() },
      });
    }
    if (messages.length === 0) return null;
    const summary = this.summaryMessage(record.last_summary);
    if (summary) messages.unshift(summary);
    return this.reconstructedState(threadId, record, messages);
  }
  private parseEvent(line: string): { role: BaseThreadState['messages'][number]['role']; content: string; ts?: string } | null {
    try {
      const event = JSON.parse(line.trim());
      return event.type === 'message' && event.role && event.content ? event : null;
    } catch { return null; }
  }
  private summaryMessage(lastSummary: string | null): BaseThreadState['messages'][number] | null {
    if (!lastSummary) return null;
    try {
      const observations = JSON.parse(lastSummary);
      if (!Array.isArray(observations)) return null;
      const groups = [['🔴', '**Critical Context:**'], ['🟡', '**Key Context:**'], ['⚪', '**Background:**']]
        .map(([priority, heading]) => {
          const matches = observations.filter(observation => observation.priority === priority);
          return matches.length ? `${ heading }\n${ matches.map(observation => `• ${ observation.content }`).join('\n') }` : null;
        }).filter((section): section is string => Boolean(section));
      return groups.length ? {
        role: 'assistant', content: `## Conversation Summary\n\n${ groups.join('\n\n') }`,
        metadata: { _conversationSummary: true, timestamp: this.now() },
      } : null;
    } catch { return null; }
  }
  private reconstructedState(
    threadId: string, record: ConversationHistoryRecord, messages: BaseThreadState['messages'],
  ): BaseThreadState {
    return { messages, metadata: {
      action: 'direct_answer', threadId, wsChannel: record.channel_id ?? '', conversationId: record.id,
      cycleComplete: false, waitingForUser: true, isSubAgent: false, subAgentDepth: 0, llmModel: '', llmLocal: false,
      options: {}, currentNodeId: 'input_handler', consecutiveSameNode: 0, iterations: 0, revisionCount: 0,
      maxIterationsReached: false, memory: { knowledgeBaseContext: '', chatSummariesContext: record.summary ?? '' },
      subGraph: { state: 'completed', name: 'hierarchical', prompt: '', response: '' },
      finalSummary: '', finalState: 'running', returnTo: null,
    } };
  }
}

export class FallbackThreadStateRepository extends Service implements ThreadStateRepository {
  constructor(
    private readonly redis: RedisThreadStateRepository,
    private readonly memory: ThreadStateRepository,
    private readonly recovery: ThreadStateRepository,
    private readonly logger: ThreadStateLogger,
  ) { super(); }
  async save(state: BaseThreadState): Promise<void> {
    if (await this.redis.available()) {
      try {
        await this.redis.save(state);
        this.logger.log(`[ThreadStateStore] Saved thread ${ state.metadata.threadId } to Redis`);
        return;
      } catch (error) { this.logger.error('[ThreadStateStore] Redis save failed, using memory fallback:', error); }
    }
    await this.memory.save(state);
  }
  async load(threadId: string): Promise<BaseThreadState | null> {
    if (await this.redis.available()) {
      try {
        const state = await this.redis.load(threadId);
        if (state) { this.logger.log(`[ThreadStateStore] Loaded thread ${ threadId } from Redis`); return state; }
      } catch (error) { this.logger.error('[ThreadStateStore] Redis load failed, checking memory fallback:', error); }
    }
    const fallback = await this.memory.load(threadId);
    if (fallback) return fallback;
    try {
      const recovered = await this.recovery.load(threadId);
      if (recovered) this.logger.log(`[ThreadStateStore] Restored thread ${ threadId } from disk JSONL, messages=${ recovered.messages.length }`);
      return recovered;
    } catch (error) {
      this.logger.error('[ThreadStateStore] Disk restoration failed for thread', threadId, error);
      return null;
    }
  }
  async delete(threadId: string): Promise<void> {
    if (await this.redis.available()) {
      try { await this.redis.delete(threadId); } catch (error) { this.logger.error('[ThreadStateStore] Redis delete failed:', error); }
    }
    await this.memory.delete(threadId);
  }
}

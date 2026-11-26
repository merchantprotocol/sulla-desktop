// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
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
export interface RedisThreadStateClientSource {
  getClient(): RedisThreadStateClient;
}
export interface ConversationHistoryLookup {
  getByThread(threadId: string): Promise<ConversationHistoryRecord | null>;
}
export interface ThreadStateLogger {
  log(message: string): void;
  error(message: string, ...details: unknown[]): void;
}

const MAX_REDIS_CHECKPOINT_BYTES = 1024 * 1024;

export class MemoryThreadStateRepository extends Service implements ThreadStateRepository {
  private readonly states = new Map<string, BaseThreadState>();
  async save(state: BaseThreadState): Promise<void> { this.states.set(state.metadata.threadId, structuredClone(state)); }
  async load(threadId: string): Promise<BaseThreadState | null> {
    const state = this.states.get(threadId);
    return state ? structuredClone(state) : null;
  }
  async delete(threadId: string): Promise<void> { this.states.delete(threadId); }
}

export class RedisThreadStateRepository extends Service implements ThreadStateRepository {
  private static readonly KEY_PREFIX = 'sulla:threadstate:';
  constructor(private readonly clientSource: RedisThreadStateClientSource, private readonly ttlSeconds = 3600) { super(); }
  async available(): Promise<boolean> {
    const client = this.clientSource.getClient();
    if (client.status !== 'ready') return false;
    try {
      await client.ping();
      return true;
    } catch {
      return false;
    }
  }
  async save(state: BaseThreadState): Promise<void> {
    await this.saveSerialized(state.metadata.threadId, JSON.stringify(structuredClone(state)));
  }
  async saveSerialized(threadId: string, json: string): Promise<void> {
    if (Buffer.byteLength(json) > MAX_REDIS_CHECKPOINT_BYTES) {
      throw new Error('Thread checkpoint exceeds the Redis size limit');
    }
    await this.clientSource.getClient().setex(
      this.key(threadId), this.ttlSeconds, json,
    );
  }
  async load(threadId: string): Promise<BaseThreadState | null> {
    const json = await this.clientSource.getClient().get(this.key(threadId));
    return json ? structuredClone(JSON.parse(json) as BaseThreadState) : null;
  }
  async delete(threadId: string): Promise<void> {
    await this.clientSource.getClient().del(this.key(threadId));
  }
  private key(threadId: string): string { return RedisThreadStateRepository.KEY_PREFIX + threadId; }
}

/** Stores the full checkpoint when a thread outgrows its Redis cache entry. */
export class FileThreadCheckpointRepository {
  constructor(private readonly directory: () => string) {}

  async exists(threadId: string): Promise<boolean> {
    try {
      await fs.promises.stat(this.filename(threadId));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  async save(threadId: string, json: string): Promise<void> {
    const filename = this.filename(threadId);
    await fs.promises.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    const temporary = `${ filename }.${ randomUUID() }.tmp`;
    try {
      await fs.promises.writeFile(temporary, json, { flag: 'wx', mode: 0o600, flush: true });
      await fs.promises.rename(temporary, filename);
    } finally {
      await fs.promises.rm(temporary, { force: true });
    }
  }

  async load(threadId: string): Promise<BaseThreadState | null> {
    try {
      return JSON.parse(await fs.promises.readFile(this.filename(threadId), 'utf8')) as BaseThreadState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async delete(threadId: string): Promise<void> {
    await fs.promises.rm(this.filename(threadId), { force: true });
  }

  private filename(threadId: string): string {
    const hash = createHash('sha256').update(threadId).digest('hex');
    return path.join(this.directory(), `${ hash }.json`);
  }
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
    const summary = this.summaryMessage(record.last_summary ?? null);
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
  private readonly operations = new Map<string, Promise<unknown>>();

  constructor(
    private readonly redis: RedisThreadStateRepository,
    private readonly memory: ThreadStateRepository,
    private readonly recovery: ThreadStateRepository,
    private readonly logger: ThreadStateLogger,
    private readonly checkpoints?: FileThreadCheckpointRepository,
  ) { super(); }
  async save(state: BaseThreadState): Promise<void> {
    const snapshot = structuredClone(state);
    const json = JSON.stringify(snapshot);
    return await this.sequence(snapshot.metadata.threadId, () => this.saveSnapshot(snapshot, json));
  }
  private async saveCheckpoint(threadId: string, json: string): Promise<boolean> {
    const hasCheckpoint = await this.checkpoints?.exists(threadId);
    if (this.checkpoints && (hasCheckpoint || Buffer.byteLength(json) > MAX_REDIS_CHECKPOINT_BYTES)) {
      // Keep later, smaller saves on disk too so a stale copy cannot win after restart.
      await this.checkpoints.save(threadId, json);
      await this.memory.delete(threadId);
      if (!hasCheckpoint) await this.deleteCachedState(threadId);
      return true;
    }
    return false;
  }

  private async saveSnapshot(state: BaseThreadState, json: string): Promise<void> {
    const threadId = state.metadata.threadId;
    const saved = await this.saveCheckpoint(threadId, json).catch(() => {
      this.logger.error('[ThreadStateStore] Checkpoint write unavailable; using fallback');
      return null;
    });
    if (saved) return;
    if (Buffer.byteLength(json) <= MAX_REDIS_CHECKPOINT_BYTES && await this.redis.available()) {
      try {
        await this.redis.saveSerialized(threadId, json);
        if (saved === null) await this.memory.save(state); // Shadow a stale file until disk writes succeed again.
        else await this.memory.delete(threadId);
        this.logger.log(`[ThreadStateStore] Saved thread ${ threadId } to Redis`);
        return;
      } catch (error) {
        // Redis reply errors may include the full checkpoint in their command arguments.
        this.logger.error('[ThreadStateStore] Redis save failed, using memory fallback:', (error as Error).message);
      }
    }
    await this.memory.save(state);
  }
  async load(threadId: string): Promise<BaseThreadState | null> {
    return await this.sequence(threadId, () => this.loadSnapshot(threadId));
  }
  private async loadSnapshot(threadId: string): Promise<BaseThreadState | null> {
    const fallback = await this.memory.load(threadId);
    if (fallback) return fallback;
    const checkpoint = await this.checkpoints?.load(threadId).catch(() => {
      this.logger.error('[ThreadStateStore] Checkpoint read unavailable; trying recovery');
      return null;
    });
    if (checkpoint) return checkpoint;
    if (await this.redis.available()) {
      try {
        const state = await this.redis.load(threadId);
        if (state) { this.logger.log(`[ThreadStateStore] Loaded thread ${ threadId } from Redis`); return state; }
      } catch (error) { this.logger.error('[ThreadStateStore] Redis load failed, checking memory fallback:', error); }
    }
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
    return await this.sequence(threadId, async() => {
      await this.deleteCachedState(threadId);
      await this.checkpoints?.delete(threadId);
      await this.memory.delete(threadId);
    });
  }
  private async deleteCachedState(threadId: string): Promise<void> {
    if (await this.redis.available()) {
      try {
        await this.redis.delete(threadId);
        this.logger.log(`[ThreadStateStore] Deleted thread ${ threadId } from Redis`);
      } catch (error) { this.logger.error('[ThreadStateStore] Redis delete failed:', error); }
    }
  }
  private async sequence<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
    const pending = this.operations.get(threadId);
    const current = pending ? pending.then(operation, operation) : operation();
    this.operations.set(threadId, current);
    try {
      return await current;
    } finally {
      if (this.operations.get(threadId) === current) this.operations.delete(threadId);
    }
  }
}

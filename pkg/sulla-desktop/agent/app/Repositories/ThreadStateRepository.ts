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

export const THREAD_STATE_TTL_SECONDS = 3600;
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
  constructor(
    private readonly clientSource: RedisThreadStateClientSource,
    private readonly ttlSeconds = THREAD_STATE_TTL_SECONDS,
    private readonly files?: FileThreadCheckpointRepository,
  ) { super(); }
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
    const thread = state.metadata.threadId;
    const json = JSON.stringify(state);
    let id: string | undefined;
    if (Buffer.byteLength(json) > MAX_REDIS_CHECKPOINT_BYTES) {
      if (!this.files) throw new Error('Thread checkpoint exceeds the Redis size limit');
      id = await this.files.write(thread, json);
    }
    // SETEX is the only publication point. Never discover a head from disk.
    await this.clientSource.getClient().setex(this.key(thread), this.ttlSeconds,
      id ? JSON.stringify({ sullaCheckpointFile: 1, id }) : json);
    await this.files?.published(thread, id);
  }
  async load(threadId: string): Promise<BaseThreadState | null> {
    const json = await this.clientSource.getClient().get(this.key(threadId));
    if (!json) return null;
    const value = JSON.parse(json);
    if (value?.sullaCheckpointFile !== 1) return value;
    if (!this.files) throw new Error('No checkpoint storage configured');
    return this.files.read(threadId, value.id);
  }
  async delete(threadId: string): Promise<void> {
    await this.clientSource.getClient().del(this.key(threadId));
  }
  private key(threadId: string): string { return RedisThreadStateRepository.KEY_PREFIX + threadId; }
}

/** Immutable payloads. A pathname is never evidence that a checkpoint is current. */
export class FileThreadCheckpointRepository {
  private static readonly ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  constructor(
    private readonly directory: () => string,
    private readonly now: () => number = Date.now,
    private readonly logger: ThreadStateLogger = console,
  ) {}

  private folder(thread: string): string {
    return path.join(this.directory(), createHash('sha256').update(thread).digest('hex'));
  }

  async write(thread: string, json: string): Promise<string> {
    const id = randomUUID();
    const folder = this.folder(thread);
    const file = path.join(folder, id + '.json');
    const tmp = file + '.tmp';
    await fs.promises.mkdir(folder, { recursive: true, mode: 0o700 });
    try {
      await fs.promises.writeFile(tmp, json, { flag: 'wx', mode: 0o600, flush: true });
      await fs.promises.rename(tmp, file);
      return id;
    } finally {
      await fs.promises.rm(tmp, { force: true });
    }
  }

  async read(thread: string, id: unknown): Promise<BaseThreadState> {
    if (typeof id !== 'string' || !FileThreadCheckpointRepository.ID.test(id)) throw new Error('Invalid checkpoint pointer');
    const state = JSON.parse(await fs.promises.readFile(path.join(this.folder(thread), id + '.json'), 'utf8'));
    if (state?.metadata?.threadId !== thread || !Array.isArray(state.messages)) throw new Error('Invalid checkpoint payload');
    return state;
  }

  // Called only after SETEX succeeds, in the same per-thread queue as saves and loads.
  async published(thread: string, id?: string): Promise<void> {
    try {
      const folder = this.folder(thread);
      if (id) {
        const time = new Date(this.now());
        await fs.promises.utimes(path.join(folder, id + '.json'), time, time);
      }
      for (const name of await fs.promises.readdir(folder)) {
        if (name !== id + '.json' && name.endsWith('.json') && FileThreadCheckpointRepository.ID.test(name.slice(0, -5))) {
          await fs.promises.rm(path.join(folder, name), { force: true });
        }
      }
    } catch (err) {
      if (!['ENOENT', 'ENOTDIR'].includes((err as NodeJS.ErrnoException).code ?? '')) {
        this.logger.error('[ThreadStateStore] Published checkpoint housekeeping failed');
      }
    }
  }

  async sweep(ttlSeconds: number): Promise<void> {
    const cutoff = this.now() - 2 * ttlSeconds * 1000;
    try {
      await this.sweepDirectory(this.directory(), cutoff, true);
    } catch (err) { this.logSweepFailure(err); }
  }

  private async sweepDirectory(dir: string, cutoff: number, root: boolean): Promise<void> {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      try {
        if (root && entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name)) {
          await this.sweepDirectory(file, cutoff, false);
        } else if (entry.isFile()) {
          const owned = root
            ? /^[a-f0-9]{64}\.json(?:\.[a-f0-9-]{36}\.tmp)?$/.test(entry.name)
            : FileThreadCheckpointRepository.ID.test(entry.name.replace(/\.json(?:\.tmp)?$/, '')) && entry.name.includes('.json');
          if (owned && (await fs.promises.lstat(file)).mtimeMs < cutoff) await fs.promises.unlink(file);
        }
      } catch (err) { this.logSweepFailure(err); }
    }
  }

  private logSweepFailure(err: unknown): void {
    if (!['ENOENT', 'ENOTDIR'].includes((err as NodeJS.ErrnoException).code ?? '')) {
      this.logger.error('[ThreadStateStore] Could not sweep checkpoint storage');
    }
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
  ) { super(); }
  async save(state: BaseThreadState): Promise<void> {
    const snapshot = structuredClone(state);
    await this.sequence(snapshot.metadata.threadId, async() => {
      if (await this.redis.available()) {
        try {
          await this.redis.save(snapshot);
          await this.memory.delete(snapshot.metadata.threadId);
          return;
        } catch {
          // Redis errors and JSON parse errors can embed private checkpoint contents.
          this.logger.error('[ThreadStateStore] Checkpoint save failed; using memory fallback');
        }
      }
      await this.memory.save(snapshot);
    });
  }
  async load(threadId: string): Promise<BaseThreadState | null> {
    return this.sequence(threadId, () => this.loadSnapshot(threadId));
  }

  private async loadSnapshot(threadId: string): Promise<BaseThreadState | null> {
    if (await this.redis.available()) {
      try {
        const state = await this.redis.load(threadId);
        if (state) return state;
      } catch { this.logger.error('[ThreadStateStore] Checkpoint read failed; trying fallback'); }
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
    return await this.sequence(threadId, async() => {
      await this.deleteCachedState(threadId);
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

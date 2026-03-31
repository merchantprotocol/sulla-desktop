// src/services/ThreadStateStore.ts
import type { BaseThreadState } from '../nodes/Graph';
import Redis from 'ioredis';
import fs from 'node:fs';
import readline from 'node:readline';

import { ConversationHistoryModel } from '../database/models/ConversationHistoryModel';

// Redis client for thread state persistence
let redis: Redis | null = null;

// Initialize Redis connection
function getRedisClient(): Redis {
  if (!redis) {
    redis = new Redis({
      host:                 process.env.REDIS_HOST || 'localhost',
      port:                 parseInt(process.env.REDIS_PORT || '6379'),
      password:             process.env.REDIS_PASSWORD,
      db:                   parseInt(process.env.REDIS_DB || '0'),
      keyPrefix:            'sulla:threadstate:',
      maxRetriesPerRequest: 3,
    });
  }
  return redis;
}

// Fallback in-memory store for development/when Redis unavailable
const threadStore = new Map<string, BaseThreadState>();

// Check if Redis is available
async function isRedisAvailable(): Promise<boolean> {
  try {
    const client = getRedisClient();
    await client.ping();
    return true;
  } catch (err) {
    console.warn('[ThreadStateStore] Redis unavailable, using in-memory storage');
    return false;
  }
}

async function reconstructState(state: BaseThreadState): Promise<BaseThreadState> {
  return structuredClone(state);
}

export async function saveThreadState(state: BaseThreadState): Promise<void> {
  const threadId = state.metadata.threadId;
  const stateData = structuredClone(state); // deep copy

  if (await isRedisAvailable()) {
    try {
      const redis = getRedisClient();
      await redis.setex(threadId, 3600, JSON.stringify(stateData)); // 1 hour TTL
      console.log(`[ThreadStateStore] Saved thread ${ threadId } to Redis`);
    } catch (err) {
      console.error('[ThreadStateStore] Redis save failed, using memory fallback:', err);
      threadStore.set(threadId, stateData);
    }
  } else {
    threadStore.set(threadId, stateData);
  }
}

export async function loadThreadState(threadId: string): Promise<BaseThreadState | null> {
  if (await isRedisAvailable()) {
    try {
      const redis = getRedisClient();
      const stateJson = await redis.get(threadId);

      if (stateJson) {
        const parsed = JSON.parse(stateJson) as BaseThreadState;
        console.log(`[ThreadStateStore] Loaded thread ${ threadId } from Redis`);
        return await reconstructState(parsed);
      }
    } catch (err) {
      console.error('[ThreadStateStore] Redis load failed, checking memory fallback:', err);
    }
  }

  // Fallback to memory store
  const saved = threadStore.get(threadId);
  if (saved) return await reconstructState(saved);

  // Final fallback: restore from disk JSONL via ConversationHistoryModel
  try {
    const restored = await restoreFromDisk(threadId);
    if (restored) {
      console.log(`[ThreadStateStore] Restored thread ${ threadId } from disk JSONL, messages=${ restored.messages.length }`);
      return restored;
    }
  } catch (err) {
    console.error('[ThreadStateStore] Disk restoration failed for thread', threadId, err);
  }

  return null;
}

/**
 * Restore a thread state from disk JSONL files when Redis TTL has expired.
 * Looks up the conversation in ConversationHistoryModel, reads the JSONL log file,
 * parses message events, and reconstructs a minimal BaseThreadState.
 */
async function restoreFromDisk(threadId: string): Promise<BaseThreadState | null> {
  // 1. Look up conversation record by thread_id
  const record = await ConversationHistoryModel.getByThread(threadId);
  if (!record || !record.log_file) {
    return null;
  }

  // 2. Check log file exists
  if (!fs.existsSync(record.log_file)) {
    console.warn(`[ThreadStateStore] Log file not found for thread ${ threadId }: ${ record.log_file }`);
    return null;
  }

  // 3. Read and parse JSONL file line by line
  const messages: BaseThreadState['messages'] = [];
  const fileStream = fs.createReadStream(record.log_file, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const event = JSON.parse(trimmed);

      // Only reconstruct from message events
      if (event.type === 'message' && event.role && event.content) {
        messages.push({
          role:     event.role,
          content:  event.content,
          metadata: { timestamp: event.ts ? new Date(event.ts).getTime() : Date.now() },
        });
      }
    } catch {
      // Skip malformed lines
    }
  }

  if (messages.length === 0) {
    console.warn(`[ThreadStateStore] No messages found in log file for thread ${ threadId }`);
    return null;
  }

  // 4. Inject conversation summary from DB as the first message if available
  if (record.last_summary) {
    try {
      const observations = JSON.parse(record.last_summary);
      if (Array.isArray(observations) && observations.length > 0) {
        const sections: string[] = [];
        const critical = observations.filter((o: any) => o.priority === '\uD83D\uDD34');
        const valuable = observations.filter((o: any) => o.priority === '\uD83D\uDFE1');
        const low = observations.filter((o: any) => o.priority === '\u26AA');

        if (critical.length > 0) {
          sections.push(`**Critical Context:**\n${ critical.map((o: any) => `• ${ o.content }`).join('\n') }`);
        }
        if (valuable.length > 0) {
          sections.push(`**Key Context:**\n${ valuable.map((o: any) => `• ${ o.content }`).join('\n') }`);
        }
        if (low.length > 0) {
          sections.push(`**Background:**\n${ low.map((o: any) => `• ${ o.content }`).join('\n') }`);
        }

        if (sections.length > 0) {
          messages.unshift({
            role:     'assistant',
            content:  `## Conversation Summary\n\n${ sections.join('\n\n') }`,
            metadata: { _conversationSummary: true, timestamp: Date.now() },
          });
        }
      }
    } catch {
      // Skip malformed summary JSON
    }
  }

  // 5. Build reconstructed BaseThreadState
  const state: BaseThreadState = {
    messages,
    metadata: {
      action:               'direct_answer',
      threadId,
      wsChannel:            record.channel_id ?? '',
      conversationId:       record.id,
      cycleComplete:        false,
      waitingForUser:       true, // Restored conversations wait for user input
      isSubAgent:           false,
      subAgentDepth:        0,
      llmModel:             '',
      llmLocal:             false,
      options:              {},
      currentNodeId:        'input_handler',
      consecutiveSameNode:  0,
      iterations:           0,
      revisionCount:        0,
      maxIterationsReached: false,
      memory:               {
        knowledgeBaseContext: '',
        chatSummariesContext: record.summary ?? '',
      },
      subGraph: {
        state:    'completed',
        name:     'hierarchical',
        prompt:   '',
        response: '',
      },
      finalSummary:         '',
      finalState:           'running',
      n8nLiveEventsEnabled: false,
      returnTo:             null,
    },
  };

  return state;
}

export async function deleteThreadState(threadId: string): Promise<void> {
  if (await isRedisAvailable()) {
    try {
      const redis = getRedisClient();
      await redis.del(threadId);
      console.log(`[ThreadStateStore] Deleted thread ${ threadId } from Redis`);
    } catch (err) {
      console.error('[ThreadStateStore] Redis delete failed:', err);
    }
  }

  // Always clean up memory store too
  threadStore.delete(threadId);
}

// ============================================================================
// REDIS-BASED COORDINATION UTILITIES
// ============================================================================

/**
 * Redis-based processing lock coordination for services
 */
export class ProcessingCoordinator {
  private static readonly LOCK_TTL = 30; // 30 seconds
  private static readonly LOCK_PREFIX = 'sulla:lock:';

  /**
   * Acquire processing lock for a service + thread combination
   */
  static async acquireLock(serviceName: string, threadId: string): Promise<boolean> {
    if (await isRedisAvailable()) {
      try {
        const redis = getRedisClient();
        const lockKey = `${ ProcessingCoordinator.LOCK_PREFIX }${ serviceName }:${ threadId }`;
        const instanceId = `${ process.pid }-${ Date.now() }`;

        // Use SET with NX (only if not exists) and EX (expiration)
        const result = await redis.set(lockKey, instanceId, 'EX', ProcessingCoordinator.LOCK_TTL, 'NX');

        if (result === 'OK') {
          console.log(`[ProcessingCoordinator] Acquired lock for ${ serviceName }:${ threadId }`);
          return true;
        } else {
          console.log(`[ProcessingCoordinator] Lock already held for ${ serviceName }:${ threadId }`);
          return false;
        }
      } catch (err) {
        console.error('[ProcessingCoordinator] Redis lock acquisition failed:', err);
        return false;
      }
    }

    // Fallback: always allow if Redis unavailable (desktop mode)
    return true;
  }

  /**
   * Release processing lock for a service + thread combination
   */
  static async releaseLock(serviceName: string, threadId: string): Promise<void> {
    if (await isRedisAvailable()) {
      try {
        const redis = getRedisClient();
        const lockKey = `${ ProcessingCoordinator.LOCK_PREFIX }${ serviceName }:${ threadId }`;
        await redis.del(lockKey);
        console.log(`[ProcessingCoordinator] Released lock for ${ serviceName }:${ threadId }`);
      } catch (err) {
        console.error('[ProcessingCoordinator] Redis lock release failed:', err);
      }
    }
  }

  /**
   * Check if processing lock exists for a service + thread combination
   */
  static async isLocked(serviceName: string, threadId: string): Promise<boolean> {
    if (await isRedisAvailable()) {
      try {
        const redis = getRedisClient();
        const lockKey = `${ ProcessingCoordinator.LOCK_PREFIX }${ serviceName }:${ threadId }`;
        const exists = await redis.exists(lockKey);
        return exists === 1;
      } catch (err) {
        console.error('[ProcessingCoordinator] Redis lock check failed:', err);
        return false;
      }
    }

    // Fallback: no locks if Redis unavailable
    return false;
  }

  /**
   * Check if any service is processing a specific thread
   */
  static async isThreadBeingProcessed(threadId: string): Promise<boolean> {
    if (await isRedisAvailable()) {
      try {
        const redis = getRedisClient();
        const pattern = `${ ProcessingCoordinator.LOCK_PREFIX }*:${ threadId }`;
        const keys = await redis.keys(pattern);
        return keys.length > 0;
      } catch (err) {
        console.error('[ProcessingCoordinator] Redis thread processing check failed:', err);
        return false;
      }
    }

    return false;
  }
}

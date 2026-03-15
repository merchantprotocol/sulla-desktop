// src/services/ThreadStateStore.ts
import type { BaseThreadState } from '../nodes/Graph';
import Redis from 'ioredis';

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
      retryDelayOnFailover: 100,
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
  return saved ? await reconstructState(saved) : null;
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

// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { threadStateProvider } from '../app/Providers/ThreadStateServiceProvider';
import { redisClient } from '../database/RedisClient';
import type { BaseThreadState } from './Graph';

export async function saveThreadState(state: BaseThreadState): Promise<void> {
  return threadStateProvider.repository.save(state);
}

export async function loadThreadState(threadId: string): Promise<BaseThreadState | null> {
  return threadStateProvider.repository.load(threadId);
}

export async function deleteThreadState(threadId: string): Promise<void> {
  return threadStateProvider.repository.delete(threadId);
}

async function isRedisAvailable(): Promise<boolean> {
  try {
    const client = redisClient.getClient();
    if (client.status !== 'ready') return false;
    await client.ping();
    return true;
  } catch {
    return false;
  }
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
        const client = redisClient.getClient();
        const lockKey = `${ ProcessingCoordinator.LOCK_PREFIX }${ serviceName }:${ threadId }`;
        const instanceId = `${ process.pid }-${ Date.now() }`;

        // Use SET with NX (only if not exists) and EX (expiration)
        const result = await client.set(lockKey, instanceId, 'EX', ProcessingCoordinator.LOCK_TTL, 'NX');

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
        const client = redisClient.getClient();
        const lockKey = `${ ProcessingCoordinator.LOCK_PREFIX }${ serviceName }:${ threadId }`;
        await client.del(lockKey);
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
        const client = redisClient.getClient();
        const lockKey = `${ ProcessingCoordinator.LOCK_PREFIX }${ serviceName }:${ threadId }`;
        const exists = await client.exists(lockKey);
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
        const client = redisClient.getClient();
        const pattern = `${ ProcessingCoordinator.LOCK_PREFIX }*:${ threadId }`;
        const keys = await client.keys(pattern);
        return keys.length > 0;
      } catch (err) {
        console.error('[ProcessingCoordinator] Redis thread processing check failed:', err);
        return false;
      }
    }

    return false;
  }
}

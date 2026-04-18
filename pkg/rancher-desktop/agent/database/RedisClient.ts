// RedisClient.ts
// Singleton wrapper around ioredis for clean, consistent access
// Mirrors memoryClient/PostgresClient structure

import Redis, { Pipeline, ChainableCommander } from 'ioredis';

const REDIS_URL = 'redis://127.0.0.1:30117';

export class RedisClient {
  private client: Redis;
  private connected = false;
  private connectionAttempts = 0;
  private maxConnectionAttempts = 30;
  private connectionRetryDelay = 2000;
  private gaveUp = false;
  private gaveUpAt = 0;
  private cooldownMs = 30_000; // retry after 30s cooldown if we gave up
  private shuttingDown = false;

  constructor() {
    this.client = this.createClient();
  }

  /**
   * Create a fresh ioredis instance with proper reconnection settings.
   * Called on construction and when a dead client needs to be replaced.
   */
  private createClient(): Redis {
    const self = this; // capture for retryStrategy closure

    const client = new Redis(REDIS_URL, {
      retryStrategy: (times: number) => {
        // During shutdown, stop retrying immediately
        if (self.shuttingDown) {
          return null;
        }

        // Back off up to 10s between retries
        const delay = Math.min(times * 200, 10_000);

        if (times % 30 === 0) {
          console.log(`[RedisClient] Still reconnecting (attempt ${ times }, next retry in ${ delay }ms)`);
        }

        return delay;
      },
      maxRetriesPerRequest: 3,
      lazyConnect:          true, // Don't auto-connect on construction
      // Enable built-in readiness checking so ioredis knows when it's safe
      enableReadyCheck: true,
    });

    client.on('connect', () => {
      this.connected = true;
      this.connectionAttempts = 0;
      this.gaveUp = false;
      console.log('[RedisClient] Connected');
    });

    client.on('ready', () => {
      this.connected = true;
      console.log('[RedisClient] Ready');
    });

    client.on('error', (err: any) => {
      this.connected = false;
      if (this.shuttingDown) return; // suppress noise during shutdown
      // Reduce error verbosity for common startup errors
      if ((err).code === 'ECONNREFUSED' || (err).code === 'EPIPE' || (err).code === 'ECONNRESET') {
        console.log(`[RedisClient] Connection error (${ (err).code }): Redis server not available yet`);
      } else {
        console.error('[RedisClient] Error:', err);
      }
    });

    client.on('close', () => {
      this.connected = false;
      if (!this.shuttingDown) {
        console.log('[RedisClient] Connection closed');
      }
    });

    // If the client enters 'end' state (retryStrategy returned null or
    // .disconnect() was called), it is permanently dead.  This should not
    // happen with our retryStrategy, but guard against it defensively.
    client.on('end', () => {
      this.connected = false;
      if (!this.shuttingDown) {
        console.warn('[RedisClient] Client entered "end" state — will recreate on next command');
      }
    });

    return client;
  }

  /**
   * Get the underlying ioredis instance
   */
  getClient(): Redis {
    return this.client;
  }

  /**
   * Initialize and test connection
   */
  async initialize(): Promise<boolean> {
    if (this.shuttingDown) return false; // Don't reconnect during shutdown
    if (this.connected) return true;

    // If the ioredis client is in 'end' state it is permanently dead and
    // cannot be reconnected.  Replace it with a fresh instance.
    if (this.client.status === 'end') {
      console.log('[RedisClient] Replacing dead client instance');
      this.client = this.createClient();
    }

    // If we previously gave up, allow retrying after a cooldown period
    if (this.gaveUp) {
      if (Date.now() - this.gaveUpAt < this.cooldownMs) {
        return false; // Still in cooldown, don't spam logs
      }
      // Cooldown expired — reset and try again
      console.log('[RedisClient] Cooldown expired, retrying connection...');
      this.gaveUp = false;
      this.connectionAttempts = 0;
    }

    // Stop trying if we've exceeded max attempts for this initialize() cycle.
    // The background retryStrategy keeps trying independently; this limit only
    // prevents the caller from blocking forever.
    if (this.connectionAttempts >= this.maxConnectionAttempts) {
      console.log(`[RedisClient] Max connection attempts (${ this.maxConnectionAttempts }) reached, will retry after ${ this.cooldownMs / 1000 }s cooldown`);
      this.gaveUp = true;
      this.gaveUpAt = Date.now();
      return false;
    }

    try {
      // With lazyConnect, we must explicitly connect before issuing commands
      if (this.client.status === 'wait') {
        await this.client.connect();
      }
      await this.client.ping();
      this.connected = true;
      this.connectionAttempts = 0;
      return true;
    } catch (error) {
      this.connectionAttempts++;
      console.log(`[RedisClient] Connection attempt ${ this.connectionAttempts }/${ this.maxConnectionAttempts } failed`);
      this.connected = false;
      return false;
    }
  }

  // Core commands with auto-init + error handling
  async set(key: string, value: string | number | Buffer, ttlSeconds?: number): Promise<'OK'> {
    await this.ensureConnected();
    return ttlSeconds
      ? this.client.set(key, value, 'EX', ttlSeconds)
      : this.client.set(key, value);
  }

  async get(key: string): Promise<string | null> {
    await this.ensureConnected();
    return this.client.get(key);
  }

  async del(keys: string | string[]): Promise<number> {
    await this.ensureConnected();
    return Array.isArray(keys)
      ? this.client.del(...keys)
      : this.client.del(keys);
  }

  async incr(key: string): Promise<number> {
    await this.ensureConnected();
    return this.client.incr(key);
  }

  async decr(key: string): Promise<number> {
    await this.ensureConnected();
    return this.client.decr(key);
  }

  async expire(key: string, seconds: number): Promise<number> {
    await this.ensureConnected();
    return this.client.expire(key, seconds);
  }

  async ttl(key: string): Promise<number> {
    await this.ensureConnected();
    return this.client.ttl(key);
  }

  async keys(pattern: string): Promise<string[]> {
    await this.ensureConnected();
    return this.client.keys(pattern);
  }

  async scan(cursor: string, ...args: string[]): Promise<[string, string[]]> {
    await this.ensureConnected();
    // Handle scan parameters properly - ioredis expects specific parameter patterns
    if (args.length === 0) {
      return this.client.scan(cursor);
    }

    // Handle MATCH pattern
    if (args[0] === 'MATCH' && args[1]) {
      if (args[2] === 'COUNT' && args[3]) {
        return this.client.scan(cursor, 'MATCH', args[1], 'COUNT', args[3]);
      }
      return this.client.scan(cursor, 'MATCH', args[1]);
    }

    // Handle COUNT
    if (args[0] === 'COUNT' && args[1]) {
      return this.client.scan(cursor, 'COUNT', args[1]);
    }

    // Fallback: call without additional args if pattern doesn't match
    return this.client.scan(cursor);
  }

  // Hash commands
  async hset(key: string, field: string, value: string): Promise<number> {
    await this.ensureConnected();
    return this.client.hset(key, field, value);
  }

  async hget(key: string, field: string): Promise<string | null> {
    await this.ensureConnected();
    return this.client.hget(key, field);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    await this.ensureConnected();
    return await this.client.hgetall(key) ?? {};
  }

  async hmget(key: string, ...fields: string[]): Promise<(string | null)[]> {
    await this.ensureConnected();
    return this.client.hmget(key, ...fields);
  }

  async hdel(key: string, ...fields: string[]): Promise<number> {
    await this.ensureConnected();
    return this.client.hdel(key, ...fields);
  }

  // List commands
  async rpush(key: string, ...values: string[]): Promise<number> {
    await this.ensureConnected();
    return this.client.rpush(key, ...values);
  }

  async lpop(key: string): Promise<string | null> {
    await this.ensureConnected();
    return this.client.lpop(key);
  }

  // Pub/Sub
  async publish(channel: string, message: string): Promise<number> {
    await this.ensureConnected();
    return this.client.publish(channel, message);
  }

  /**
   * Wait until Redis is actually reachable from the host.
   * Called by ServiceLifecycleManager before any service that needs Redis.
   */
  async waitForReady(maxAttempts = 60, intervalMs = 2000): Promise<void> {
    for (let i = 1; i <= maxAttempts; i++) {
      try {
        if (this.client.status === 'end') {
          this.client = this.createClient();
        }
        if (this.client.status === 'wait') {
          await this.client.connect();
        }
        await this.client.ping();
        this.connected = true;
        this.connectionAttempts = 0;
        console.log(`[RedisClient] Host port 30117 reachable (attempt ${ i })`);

        return;
      } catch {
        if (i === maxAttempts) {
          throw new Error(`Redis not reachable after ${ maxAttempts } attempts`);
        }
        console.log(`[RedisClient] waitForReady attempt ${ i }/${ maxAttempts } failed, retrying...`);
        await new Promise(r => setTimeout(r, intervalMs));
      }
    }
  }

  // Close connection (call on shutdown)
  async close(): Promise<void> {
    this.shuttingDown = true;

    try {
      // Force-disconnect immediately to stop the retry loop
      this.client.disconnect();
    } catch {
      // already disconnected
    }
    this.connected = false;
    this.gaveUp = false;
    this.connectionAttempts = 0;
  }

  // Pipeline support
  pipeline(): Pipeline {
    return this.client.pipeline() as Pipeline;
  }

  private async ensureConnected(): Promise<void> {
    if (this.shuttingDown) {
      throw new Error('Redis is shutting down — refusing new connections');
    }
    if (!this.connected) {
      const ok = await this.initialize();
      if (!ok) {
        if (this.gaveUp) {
          throw new Error(`Redis not available (cooling down, will retry after ${ this.cooldownMs / 1000 }s)`);
        } else {
          throw new Error('Redis server not available yet');
        }
      }
    }
  }
}

// Singleton
export const redisClient = new RedisClient();

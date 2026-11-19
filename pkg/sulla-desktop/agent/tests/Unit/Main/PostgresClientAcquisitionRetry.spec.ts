// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { EventEmitter } from 'node:events';

import { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PostgresClient } from '@pkg/agent/database/PostgresClient';

describe('PostgresClient safe acquisition retry', () => {
  const previousUrl = process.env.SULLA_DATABASE_URL;
  const originalWarn = console.warn;

  afterEach(() => {
    vi.useRealTimers();
    console.warn = originalWarn;
    if (previousUrl === undefined) delete process.env.SULLA_DATABASE_URL;
    else process.env.SULLA_DATABASE_URL = previousUrl;
  });

  it('waits through a five-second connection refusal before starting one chat save transaction', async() => {
    vi.useFakeTimers();
    process.env.SULLA_DATABASE_URL = 'postgres://sulla:unused@127.0.0.1:30116/sulla';
    console.warn = vi.fn();
    const statements: string[] = [];
    const query = vi.fn(async(statement: string, _params?: unknown[]) => {
      statements.push(statement);
      return { rows: [] };
    });
    const pooledClient = { query, release: vi.fn() };
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED', port: 30116 });
    const connect = vi.fn();
    for (let attempt = 0; attempt < 7; attempt++) connect.mockRejectedValueOnce(refused);
    connect.mockResolvedValueOnce(pooledClient);
    const client = new PostgresClient();
    (client as any).pool = { connect, end: vi.fn(async() => undefined) };
    (client as any).connected = true;
    const save = vi.fn(async(transactionClient: any) => {
      await transactionClient.query('INSERT INTO conversation_messages (id) VALUES ($1)', ['message-1']);
      return 'saved';
    });

    const operation = client.transaction(save as any);
    for (let attempt = 0; attempt < 8; attempt++) {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_000);
    }
    await expect(operation).resolves.toBe('saved');
    expect(connect).toHaveBeenCalledTimes(8);
    expect(statements.filter(statement => statement.startsWith('INSERT'))).toHaveLength(1);
    expect(statements).toEqual([
      'BEGIN', 'INSERT INTO conversation_messages (id) VALUES ($1)', 'COMMIT',
    ]);
    await client.end();
  });

  it('does not replay a write after a checked-out connection fails during the transaction', async() => {
    process.env.SULLA_DATABASE_URL = 'postgres://sulla:unused@127.0.0.1:30116/sulla';
    const writeError = Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' });
    const query = vi.fn(async(statement: string) => {
      if (statement.startsWith('INSERT')) throw writeError;
      if (statement === 'ROLLBACK') throw writeError;
      return { rows: [] };
    });
    const connect = vi.fn(async() => ({ query, release: vi.fn() }));
    const client = new PostgresClient();
    (client as any).pool = { connect, end: vi.fn(async() => undefined) };
    (client as any).connected = true;

    await expect(client.transaction(async(transactionClient: any) => transactionClient.query('INSERT INTO chat_receipts (id) VALUES ($1)', ['receipt-1']))).rejects.toBe(writeError);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.filter(([statement]) => statement.startsWith('INSERT'))).toHaveLength(1);
    await client.end();
  });

  it('recovers one chat save after a ninety-second stalled dial and does not replay the transaction', async() => {
    vi.useFakeTimers();
    process.env.SULLA_DATABASE_URL = 'postgres://sulla:unused@127.0.0.1:30116/sulla';
    console.warn = vi.fn();
    const connectTimeoutMs = 10_000;
    const outageMs = 90_000;
    const origin = performance.now();
    const stalled = new Error('Connection terminated due to connection timeout');
    const statements: string[] = [];
    const startedAt: number[] = [];
    const query = vi.fn(async(statement: string) => {
      statements.push(statement);
      return { rows: [] };
    });
    const pooledClient = { query, release: vi.fn() };
    const connect = vi.fn(() => new Promise((resolve, reject) => {
      const elapsed = performance.now() - origin;
      startedAt.push(elapsed);
      if (elapsed >= outageMs) {
        resolve(pooledClient);
        return;
      }
      setTimeout(() => reject(stalled), connectTimeoutMs);
    }));
    const client = installPool(new PostgresClient(), connect, connectTimeoutMs);
    const save = vi.fn(async(transactionClient: any) => {
      await transactionClient.query('INSERT INTO conversation_messages (id) VALUES ($1)', ['message-90s']);
      return 'saved';
    });

    const operation = client.transaction(save as any);
    const settled = capture(operation);
    await driveFakeClock(outageMs + (2 * connectTimeoutMs) + 1_000 + 5_000);
    await expect(settled).resolves.toMatchObject({ ok: true, value: 'saved' });
    expect(startedAt.at(-1)).toBeGreaterThanOrEqual(outageMs);
    expect(startedAt.length).toBeGreaterThan(1);
    for (const elapsed of startedAt) {
      expect(elapsed + connectTimeoutMs).toBeLessThanOrEqual(acquisitionWindowMs(connectTimeoutMs) + 1);
    }
    expect(statements).toEqual([
      'BEGIN', 'INSERT INTO conversation_messages (id) VALUES ($1)', 'COMMIT',
    ]);
    expect(client.isConnected()).toBe(true);
    await client.end();
  });

  it('surfaces the dial error once the next connect timeout no longer fits the finite window', async() => {
    vi.useFakeTimers();
    process.env.SULLA_DATABASE_URL = 'postgres://sulla:unused@127.0.0.1:30116/sulla';
    console.warn = vi.fn();
    const connectTimeoutMs = 10_000;
    const origin = performance.now();
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED', port: 30116 });
    const connect = vi.fn(async() => { throw refused });
    const client = installPool(new PostgresClient(), connect, connectTimeoutMs);
    const operation = client.getClient();
    const settled = capture(operation);

    await driveFakeClock(acquisitionWindowMs(connectTimeoutMs) + connectTimeoutMs);
    const result = await settled;
    expect(result).toEqual({ ok: false, error: refused });
    expect(connect.mock.calls.length).toBeGreaterThan(1);
    expect(performance.now() - origin).toBeGreaterThanOrEqual(90_000);
    expect(performance.now() - origin).toBeLessThanOrEqual(acquisitionWindowMs(connectTimeoutMs) + 1_000);
    expect(client.isConnected()).toBe(false);
    await client.end();
  });

  it('does not retry a pool-capacity checkout or mark the process disconnected', async() => {
    process.env.SULLA_DATABASE_URL = 'postgres://sulla:unused@127.0.0.1:30116/sulla';
    console.warn = vi.fn();
    const capacity = new Error('timeout exceeded when trying to connect');
    const connect = vi.fn(async() => { throw capacity });
    const client = installPool(new PostgresClient(), connect, 10_000);

    await expect(client.getClient()).rejects.toBe(capacity);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(client.isConnected()).toBe(true);
    expect(console.warn).not.toHaveBeenCalled();
    await client.end();
  });

  it('does not retry authentication or permission failures during acquisition', async() => {
    process.env.SULLA_DATABASE_URL = 'postgres://sulla:unused@127.0.0.1:30116/sulla';
    const auth = Object.assign(new Error('password authentication failed'), { code: '28P01' });
    const permission = Object.assign(new Error('permission denied for table conversation_messages'), { code: '42501' });
    for (const failure of [auth, permission]) {
      const connect = vi.fn(async() => { throw failure });
      const client = installPool(new PostgresClient(), connect, 10_000);
      await expect(client.getClient()).rejects.toBe(failure);
      expect(connect).toHaveBeenCalledTimes(1);
      await client.end();
    }
  });

  it('rides out queued pool-capacity timeouts during a known ninety-second dial outage for fifty concurrent saves', async() => {
    vi.useFakeTimers();
    process.env.SULLA_DATABASE_URL = 'postgres://sulla:unused@127.0.0.1:30116/sulla';
    console.warn = vi.fn();
    const connectTimeoutMs = 10_000;
    const outageMs = 90_000;
    const origin = performance.now();
    const statements: string[] = [];
    const failures: string[] = [];
    // The real pg-pool (max 20) owns queueing and its pending-checkout timer; only the socket dial is fake.
    const pool = realPool(20, connectTimeoutMs, () => performance.now() - origin >= outageMs, statements);
    const connect = pool.connect.bind(pool);
    (pool as any).connect = () => connect().catch((error: Error) => { failures.push(error.message); throw error });
    const client = new PostgresClient();
    (client as any).pool = pool;
    (client as any).connected = true;

    const saves = Array.from({ length: 50 }, (_, index) => capture(client.transaction(async(transactionClient: any) => {
      await transactionClient.query('INSERT INTO conversation_messages (id) VALUES ($1)', [`message-${ index }`]);
      return index;
    })));
    await driveFakeClock(acquisitionWindowMs(connectTimeoutMs) + 5_000);
    const results = await Promise.all(saves);

    expect(failures).toContain('timeout exceeded when trying to connect');
    expect(failures.some(message => message === 'Connection terminated due to connection timeout')).toBe(true);
    expect(results).toEqual(Array.from({ length: 50 }, (_, index) => ({ ok: true, value: index })));
    // Exactly one write per save: acquisition retries never replay SQL.
    const inserts = statements.filter(statement => statement.startsWith('INSERT'));
    expect(inserts).toHaveLength(50);
    expect(statements.filter(statement => statement === 'BEGIN')).toHaveLength(50);
    expect(statements.filter(statement => statement === 'COMMIT')).toHaveLength(50);
    expect(client.isConnected()).toBe(true);
    await client.end();
  });

  it('surfaces ordinary pool capacity once, without a known outage, from the real pending-checkout timer', async() => {
    vi.useFakeTimers();
    process.env.SULLA_DATABASE_URL = 'postgres://sulla:unused@127.0.0.1:30116/sulla';
    console.warn = vi.fn();
    const statements: string[] = [];
    const pool = realPool(1, 10_000, () => true, statements);
    const connect = vi.spyOn(pool, 'connect');
    const client = new PostgresClient();
    (client as any).pool = pool;
    (client as any).connected = true;
    const held = await client.getClient();
    const waiting = capture(client.getClient());
    await driveFakeClock(15_000);
    const result = await waiting;
    expect(result).toMatchObject({ ok: false, error: { message: 'timeout exceeded when trying to connect' } });
    expect(connect).toHaveBeenCalledTimes(2);
    expect(client.isConnected()).toBe(true);
    expect(console.warn).not.toHaveBeenCalled();
    held.release();
    await client.end();
  });

  it('stops the acquisition backoff when shutdown starts', async() => {
    vi.useFakeTimers();
    process.env.SULLA_DATABASE_URL = 'postgres://sulla:unused@127.0.0.1:30116/sulla';
    console.warn = vi.fn();
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED', port: 30116 });
    const connect = vi.fn(async() => { throw refused });
    const client = installPool(new PostgresClient(), connect, 10_000);
    const operation = client.getClient();
    const shutdown = expect(operation).rejects.toThrow(/shutting down/);
    await Promise.resolve();
    await Promise.resolve();
    expect(connect).toHaveBeenCalledTimes(1);
    (client as any).shuttingDown = true;
    await vi.advanceTimersByTimeAsync(1_000);
    await shutdown;
    expect(connect).toHaveBeenCalledTimes(1);
    await client.end();
  });
});

/** Approved acquisition bound: 90s dial outage, the in-flight timeout, one backoff, and the recovering timeout. */
function acquisitionWindowMs(connectTimeoutMs: number): number {
  return 90_000 + (2 * connectTimeoutMs) + 1_000;
}

/**
 * A real pg Pool whose Client dials stall until `up()` is true, then connect. pg-pool's own
 * connect timer ends a stalled dial; its pending-checkout timer produces the capacity error.
 */
function realPool(max: number, connectTimeoutMs: number, up: () => boolean, statements: string[]): Pool {
  class StalledDialClient extends EventEmitter {
    _queryable = false;
    _ending = false;
    private pendingConnect: ((error?: Error) => void) | null = null;
    isConnected() { return this._queryable }
    connect(callback: (error?: Error) => void) {
      if (up()) {
        process.nextTick(() => { this._queryable = true; callback() });
        return;
      }
      this.pendingConnect = callback;
    }
    end(callback?: () => void) {
      this._ending = true;
      const pending = this.pendingConnect;
      this.pendingConnect = null;
      process.nextTick(() => {
        pending?.(new Error('Connection terminated unexpectedly'));
        this.emit('end');
        callback?.();
      });
    }
    async query(statement: string) {
      statements.push(statement);
      return { rows: [] };
    }
  }
  return new Pool({ Client: StalledDialClient as any, max, connectionTimeoutMillis: connectTimeoutMs, idleTimeoutMillis: 0 });
}

function installPool(client: PostgresClient, connect: ReturnType<typeof vi.fn>, connectTimeoutMs: number): PostgresClient {
  (client as any).pool = { connect, options: { connectionTimeoutMillis: connectTimeoutMs }, end: vi.fn(async() => undefined) };
  (client as any).connected = true;
  return client;
}

function capture<T>(operation: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  return operation.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
}

async function driveFakeClock(ceilingMs: number): Promise<void> {
  const started = performance.now();
  for (let step = 0; step < 5_000; step++) {
    for (let flush = 0; flush < 8; flush++) await Promise.resolve();
    if (vi.getTimerCount() === 0) return;
    if (performance.now() - started > ceilingMs) return;
    await vi.advanceTimersToNextTimerAsync();
  }
}

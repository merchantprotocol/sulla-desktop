// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PostgresClient } from '@pkg/agent/database/PostgresClient';

/**
 * E10 trust removal: once Postgres checks passwords, the host pool must send
 * the CURRENT service secret on every new connection, and a refused secret
 * must be visible in the boot log instead of looking like a silent hang.
 * pg is replaced by a recorder so no database is needed.
 *
 * vi.hoisted runs before static imports are initialised, so EventEmitter is
 * loaded inside the hoisted block rather than from a top-level import.
 */
const harness = await vi.hoisted(async() => {
  const { EventEmitter } = await import('node:events');
  const state = {
    secret:      'secret-one',
    pools:       [] as Array<{ options: Record<string, unknown> }>,
    queryErrors: [] as unknown[],
  };

  class FakePool extends EventEmitter {
    constructor(readonly options: Record<string, unknown>) {
      super();
      state.pools.push(this);
    }

    async query(): Promise<{ rows: unknown[] }> {
      const queued = state.queryErrors.shift();
      const next = typeof queued === 'function' ? queued() : queued;

      if (next) throw next;

      return { rows: [] };
    }

    async connect(): Promise<{ query: () => Promise<unknown>; release: () => void }> {
      return { query: async() => ({ rows: [] }), release: () => undefined };
    }

    async end(): Promise<void> { /* recorder */ }
  }

  return { state, FakePool };
});

vi.mock('pg', () => ({ Pool: harness.FakePool, default: { Pool: harness.FakePool } }));
vi.mock('@pkg/agent/app/Providers/ServiceSecretServiceProvider', () => ({
  serviceSecretProvider: { value: async() => harness.state.secret },
}));

function pgError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, severity: 'FATAL' });
}

describe('PostgresClient service secret per connection', () => {
  const previousUrl = process.env.SULLA_DATABASE_URL;

  beforeEach(() => {
    delete process.env.SULLA_DATABASE_URL;
    harness.state.secret = 'secret-one';
    harness.state.pools.length = 0;
    harness.state.queryErrors.length = 0;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousUrl === undefined) delete process.env.SULLA_DATABASE_URL;
    else process.env.SULLA_DATABASE_URL = previousUrl;
  });

  // risk: auth outage — a rotated secret must reach new pool connections, not stay pinned from boot
  it('gives the pool a password function that reads the current secret for each new connection', async() => {
    const client = new PostgresClient();

    await client.initialize();

    const password = harness.state.pools[0].options.password;

    expect(typeof password).toBe('function');
    await expect((password as () => Promise<string>)()).resolves.toBe('secret-one');

    harness.state.secret = 'secret-two';

    await expect((password as () => Promise<string>)()).resolves.toBe('secret-two');
    await client.end();
  });

  // risk: behaviour drift — an explicit SULLA_DATABASE_URL still owns the credentials
  it('leaves the SULLA_DATABASE_URL override untouched', async() => {
    process.env.SULLA_DATABASE_URL = 'postgres://sulla:override@127.0.0.1:1/sulla';
    const client = new PostgresClient();

    await client.initialize();

    expect(harness.state.pools[0].options.connectionString).toBe('postgres://sulla:override@127.0.0.1:1/sulla');
    expect(harness.state.pools[0].options.password).toBeUndefined();
    await client.end();
  });

  // risk: silent boot hang — a refused secret must be logged as an authentication failure, without the secret
  it('logs 28P01 as an authentication failure, distinct from unreachable, and keeps retrying', async() => {
    harness.state.queryErrors.push(
      pgError('28P01', 'password authentication failed for user "sulla"'),
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:30116'), { code: 'ECONNREFUSED' }),
    );
    const client = new PostgresClient();

    await client.waitForReady(3, 0);

    const errors = vi.mocked(console.error).mock.calls.map(call => String(call[0]));
    const logs = vi.mocked(console.log).mock.calls.map(call => String(call[0]));

    expect(errors).toEqual([expect.stringMatching(/attempt 1\/3: authentication failed \(SQLSTATE 28P01, class 28\)/)]);
    expect(logs).toContain('[PostgresClient] waitForReady attempt 2/3 failed (unreachable: ECONNREFUSED), retrying...');
    expect(logs.some(line => line.includes('reachable (attempt 3)'))).toBe(true);

    const everything = [...errors, ...logs, ...vi.mocked(console.warn).mock.calls.map(call => String(call[0]))].join('\n');

    expect(everything).not.toContain('secret-one');
    expect(everything).not.toContain('password authentication failed');
  });

  // risk: auth outage — the readiness probe must use the secret current at each attempt
  it('reads the secret again on every readiness attempt', async() => {
    // The secret rotates while the first probe is being refused.
    harness.state.queryErrors.push(() => {
      harness.state.secret = 'secret-two';

      return pgError('28P01', 'password authentication failed');
    });
    const client = new PostgresClient();

    await client.waitForReady(2, 0);

    expect(harness.state.pools.map(pool => pool.options.password)).toEqual(['secret-one', 'secret-two']);
  });

  // risk: diagnosis — the final failure names the reason class, never the message text
  it('names the last failure reason when attempts run out', async() => {
    harness.state.queryErrors.push(pgError('28P01', 'password authentication failed'), pgError('28P01', 'password authentication failed'));
    const client = new PostgresClient();

    await expect(client.waitForReady(2, 0)).rejects.toThrow('PostgreSQL not reachable after 2 attempts (SQLSTATE 28P01, class 28)');
  });
});

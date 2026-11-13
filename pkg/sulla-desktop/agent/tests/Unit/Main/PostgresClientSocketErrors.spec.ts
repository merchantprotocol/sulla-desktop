// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PostgresClient } from '@pkg/agent/database/PostgresClient';

/**
 * Regression for the main-process "UncaughtException: Connection terminated
 * unexpectedly" storm: pg-pool removes its own 'error' listener while a
 * client is checked out, so a Postgres restart made every in-flight client
 * emit an unhandled 'error'. No database is needed: the pool is pointed at a
 * closed port and a stand-in client is handed to its 'connect' event.
 */
describe('PostgresClient pooled socket errors', () => {
  const previousUrl = process.env.SULLA_DATABASE_URL;
  let client: PostgresClient;

  beforeEach(async() => {
    // Port 1 refuses immediately; initialize() logs and stays disconnected.
    process.env.SULLA_DATABASE_URL = 'postgres://sulla:unused@127.0.0.1:1/sulla';
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    client = new PostgresClient();
    await client.initialize();
  });

  afterEach(async() => {
    await client.end();
    vi.restoreAllMocks();
    if (previousUrl === undefined) delete process.env.SULLA_DATABASE_URL;
    else process.env.SULLA_DATABASE_URL = previousUrl;
  });

  function connectStandInClient(): EventEmitter {
    const pooled = new EventEmitter();
    const pool = (client as unknown as { pool: EventEmitter }).pool;

    pool.emit('connect', pooled);

    return pooled;
  }

  // risk: crash — a dropped checked-out connection must not become an UncaughtException
  it('handles an error on a checked-out client instead of throwing', () => {
    const pooled = connectStandInClient();

    // EventEmitter.emit('error') throws when nobody listens; that throw is the
    // UncaughtException seen in the logs.
    expect(() => pooled.emit('error', new Error('Connection terminated unexpectedly'))).not.toThrow();
    expect(client.isConnected()).toBe(false);
  });

  // risk: log noise — a restart drops every connection at once; log the outage once
  it('logs one line when many connections drop together', () => {
    const clients = Array.from({ length: 25 }, () => connectStandInClient());
    const warn = vi.mocked(console.warn);
    warn.mockClear();

    for (const pooled of clients) pooled.emit('error', new Error('Connection terminated unexpectedly'));

    expect(warn.mock.calls.filter(call => String(call[0]).includes('Database connection lost'))).toHaveLength(1);
  });

  // risk: hiding real failures — a socket error that is not an outage is still reported as an error
  it('still reports unexpected socket errors loudly', () => {
    const pooled = connectStandInClient();
    const error = vi.mocked(console.error);
    error.mockClear();

    pooled.emit('error', new Error('SSL routines: bad record mac'));

    expect(error).toHaveBeenCalledWith('[PostgresPool] Unexpected error on client', expect.any(Error));
  });
});

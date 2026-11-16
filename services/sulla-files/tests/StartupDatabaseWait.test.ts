// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';
import { StartupDatabaseWait } from '../src/StartupDatabaseWait.js';

function harness(deadlineMs = 10_000) {
  let clock = 0; const sleeps:number[] = []; const warnings:string[] = [];
  const wait = new StartupDatabaseWait({
    name: 'test', deadlineMs, initialDelayMs: 100, maxDelayMs: 400,
    sleep: async ms => { sleeps.push(ms); clock += ms }, now: () => clock,
    log: { warn: (line:string) => warnings.push(line), log: () => undefined },
  });
  return { wait, sleeps, warnings };
}

describe('StartupDatabaseWait', () => {
  it('retries while Postgres is unreachable with capped backoff, then returns the probe result', async() => {
    // risk: availability — a service crashes on boot because Postgres DNS is not registered yet.
    const { wait, sleeps, warnings } = harness();
    const failures = [Object.assign(new Error('getaddrinfo ENOTFOUND postgres'), { code: 'ENOTFOUND' }), Object.assign(new Error('starting up'), { code: '57P03' }), new Error('Connection terminated unexpectedly'), Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })];
    let calls = 0;
    const result = await wait.until('connect', async() => { calls++; const failure = failures.shift(); if (failure) throw failure; return 'ok' });
    expect(result).toBe('ok');
    expect(calls).toBe(5);
    expect(sleeps).toEqual([100, 200, 400, 400]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('ENOTFOUND');
  });

  it('throws configuration and SQL errors at once without retrying', async() => {
    // risk: a wrong password or missing database is retried for minutes instead of failing loudly.
    const { wait, sleeps } = harness();
    const denied = Object.assign(new Error('password authentication failed'), { code: '28P01' });
    await expect(wait.until('connect', async() => { throw denied })).rejects.toBe(denied);
    expect(sleeps).toEqual([]);
  });

  it('gives up with the last error once the deadline would pass', async() => {
    // risk: a dead Postgres hangs start-up forever instead of letting Docker restart the service.
    const { wait, sleeps } = harness(500);
    const refused = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
    await expect(wait.until('connect', async() => { throw refused })).rejects.toBe(refused);
    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(500);
  });

  it('treats an AggregateError as unreachable only when every inner error is', () => {
    // risk: a mixed dual-stack failure hides a real configuration error behind retries.
    const refused = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
    expect(StartupDatabaseWait.isUnreachable({ errors: [refused, refused] })).toBe(true);
    expect(StartupDatabaseWait.isUnreachable({ errors: [refused, Object.assign(new Error('x'), { code: '28P01' })] })).toBe(false);
  });
});

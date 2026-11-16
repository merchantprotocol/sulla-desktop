// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { StartupDatabaseWait } from '../../../../../../services/sulla-accounts/src/StartupDatabaseWait';

function pgError(code: string, message = code): Error {
  return Object.assign(new Error(message), { code });
}

class Clock {
  now = 0;
  readonly sleeps: number[] = [];
  readonly sleep = async(ms: number) => { this.sleeps.push(ms); this.now += ms };
}

function waiter(clock: Clock, deadlineMs = 60_000): StartupDatabaseWait {
  return new StartupDatabaseWait({ name: 'test', deadlineMs, sleep: clock.sleep, now: () => clock.now, log: { warn: () => {}, log: () => {} } });
}

describe('StartupDatabaseWait', () => {
  // risk: availability — a service started before Postgres's DNS name exists must wait, not crash
  it('retries while Postgres is not resolvable or still starting, with capped backoff', async() => {
    const clock = new Clock();
    const failures = [pgError('ENOTFOUND', 'getaddrinfo ENOTFOUND postgres'), pgError('ECONNREFUSED'), pgError('57P03', 'the database system is starting up'),
      new Error('timeout exceeded when trying to connect'), pgError('ENOTFOUND'), pgError('ENOTFOUND'), pgError('ENOTFOUND')];
    let calls = 0;

    await expect(waiter(clock).until('connect', async() => {
      calls += 1;
      if (failures.length) throw failures.shift();

      return 'up';
    })).resolves.toBe('up');
    expect(calls).toBe(8);
    expect(clock.sleeps).toEqual([500, 1000, 2000, 4000, 5000, 5000, 5000]);
  });

  // risk: real fatals — a wrong password or missing database must still fail at once so ProcessGuard exits
  it('throws non-connection errors immediately without retrying', async() => {
    const clock = new Clock();
    let calls = 0;
    const authFailure = pgError('28P01', 'password authentication failed for user "sulla"');

    await expect(waiter(clock).until('connect', async() => { calls += 1; throw authFailure })).rejects.toBe(authFailure);
    expect(calls).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });

  // risk: availability — a Postgres that never comes up must end in the restart path, not a silent hang
  it('gives up with the last connection error once the deadline would pass', async() => {
    const clock = new Clock();
    const down = pgError('ENOTFOUND', 'getaddrinfo ENOTFOUND postgres');

    await expect(waiter(clock, 10_000).until('connect', async() => { throw down })).rejects.toBe(down);
    expect(clock.now).toBeLessThanOrEqual(10_000);
    expect(clock.sleeps.length).toBeGreaterThan(1);
  });
});

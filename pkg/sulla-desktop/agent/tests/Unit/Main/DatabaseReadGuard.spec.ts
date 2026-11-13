// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { DatabaseUnavailableClassifier } from '@pkg/agent/database/DatabaseAvailability';
import { DatabaseReadGuard } from '@pkg/main/DatabaseReadGuard';

const DB_PORT = 30116;

function pgError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function refused(port: number): Error {
  return Object.assign(new Error(`connect ECONNREFUSED 127.0.0.1:${ port }`), { code: 'ECONNREFUSED', port, address: '127.0.0.1' });
}

class GuardHarness {
  readonly sleeps: number[] = [];
  readonly logs: string[] = [];
  notified = 0;
  probes = 0;
  shuttingDown = false;
  probeResults: Array<'up' | 'down'> = [];
  readonly guard: DatabaseReadGuard;
  private openRecovery!: () => void;
  /** Recovery-poll waits (>= 100ms here) park until the test opens them. */
  private readonly recoveryOpen = new Promise<void>((resolve) => { this.openRecovery = resolve });

  constructor() {
    this.guard = new DatabaseReadGuard({
      classifier:      new DatabaseUnavailableClassifier(DB_PORT),
      probe:           async() => {
        this.probes++;
        if ((this.probeResults.shift() ?? 'down') === 'down') throw refused(DB_PORT);
      },
      notifyAvailable: () => { this.notified++ },
      isShuttingDown:  () => this.shuttingDown,
      logger:          { info: message => this.logs.push(message) },
      sleep:           async(ms) => {
        this.sleeps.push(ms);
        if (ms >= 100) await this.recoveryOpen;
      },
      retryDelaysMs:   [10, 20],
      recoveryMinMs:   100,
      recoveryMaxMs:   400,
    });
  }

  releaseRecoveryPoll(): void {
    this.openRecovery();
  }

  /** A read that fails `failures` times with `error`, then returns `value`. */
  flakyRead<T>(failures: number, error: Error, value: T): { read: () => Promise<T>; calls: () => number } {
    let calls = 0;

    return {
      read:  async() => {
        calls++;
        if (calls <= failures) throw error;

        return value;
      },
      calls: () => calls,
    };
  }
}

describe('DatabaseUnavailableClassifier', () => {
  const classifier = new DatabaseUnavailableClassifier(DB_PORT);

  // risk: data accuracy — only "database not reachable" may be turned into an empty list
  it('treats Postgres start-up/shut-down and lost sockets as unavailable', () => {
    expect(classifier.isUnavailable(pgError('57P03', 'the database system is starting up'))).toBe(true);
    expect(classifier.isUnavailable(pgError('57P03', 'the database system is shutting down'))).toBe(true);
    expect(classifier.isUnavailable(refused(DB_PORT))).toBe(true);
    expect(classifier.isUnavailable(new Error('Connection terminated unexpectedly'))).toBe(true);
    expect(classifier.isUnavailable(new Error('timeout exceeded when trying to connect'))).toBe(true);
    expect(classifier.isUnavailable(new AggregateError([refused(DB_PORT), refused(DB_PORT)], ''))).toBe(true);
  });

  // risk: hiding real failures — query bugs and other services' outages must still surface
  it('does not treat query errors or other ports as the database being down', () => {
    expect(classifier.isUnavailable(pgError('42P01', 'relation "workflows" does not exist'))).toBe(false);
    expect(classifier.isUnavailable(pgError('23505', 'duplicate key value violates unique constraint'))).toBe(false);
    expect(classifier.isUnavailable(refused(443))).toBe(false);
    expect(classifier.isUnavailable(new TypeError('Cannot read properties of undefined'))).toBe(false);
    expect(classifier.isUnavailable(undefined)).toBe(false);
  });
});

describe('DatabaseReadGuard', () => {
  // risk: data accuracy — a short start-up blip still returns the real rows
  it('retries with backoff and returns the real result once the database answers', async() => {
    const h = new GuardHarness();
    const flaky = h.flakyRead(2, pgError('57P03', 'the database system is starting up'), ['row']);

    await expect(h.guard.run('functions-list', flaky.read, [])).resolves.toEqual(['row']);
    expect(flaky.calls()).toBe(3);
    expect(h.sleeps).toEqual([10, 20]);
    expect(h.notified).toBe(0);
    expect(h.logs).toEqual([]);
  });

  // risk: crash/noise — a down database yields the not-ready value instead of a rejected IPC call
  it('returns the not-ready value after the retry budget and logs the outage once', async() => {
    const h = new GuardHarness();
    const down = refused(DB_PORT);

    await expect(h.guard.run('workflow-db-list', h.flakyRead(99, down, ['x']).read, [])).resolves.toEqual([]);
    await expect(h.guard.run('chat-artifacts:list', h.flakyRead(99, down, ['x']).read, null)).resolves.toBeNull();

    expect(h.logs.filter(line => line.includes('not reachable'))).toHaveLength(1);
    expect(h.guard.isDatabaseDown).toBe(true);
  });

  // risk: hiding real failures — a broken query must still reject without retries
  it('rethrows errors that are not about the database being unreachable', async() => {
    const h = new GuardHarness();
    const broken = h.flakyRead(99, pgError('42703', 'column "nodecount" does not exist'), []);

    await expect(h.guard.run('workflow-db-list', broken.read, [])).rejects.toThrow('column "nodecount" does not exist');
    expect(broken.calls()).toBe(1);
    expect(h.sleeps).toEqual([]);
  });

  // risk: stale UI — renderers that got an empty list are told exactly once when to reload
  it('polls with growing waits and broadcasts database:available once when it comes back', async() => {
    const h = new GuardHarness();
    h.probeResults = ['down', 'down', 'down', 'up'];
    h.releaseRecoveryPoll();

    await h.guard.run('library-list-skills', h.flakyRead(99, refused(DB_PORT), []).read, []);
    await h.guard.settled();

    expect(h.notified).toBe(1);
    expect(h.probes).toBe(4);
    expect(h.guard.isDatabaseDown).toBe(false);
    // 2 in-call retries, then recovery waits 100 → 200 → 400 → 400 (capped)
    expect(h.sleeps).toEqual([10, 20, 100, 200, 400, 400]);

    // A later healthy call does not re-announce.
    await h.guard.run('library-list-skills', async() => ['ok'], []);
    expect(h.notified).toBe(1);
  });

  // risk: stale UI — a guarded call that succeeds first ends the outage and notifies once
  it('ends the outage on the first successful guarded read', async() => {
    const h = new GuardHarness();
    await h.guard.run('functions-list', h.flakyRead(99, refused(DB_PORT), []).read, []);
    await expect(h.guard.run('functions-list', async() => ['fn'], [])).resolves.toEqual(['fn']);

    expect(h.notified).toBe(1);
    expect(h.guard.isDatabaseDown).toBe(false);

    // The parked recovery poll wakes, sees the outage is over and stops without probing.
    h.releaseRecoveryPoll();
    await h.guard.settled();
    expect(h.notified).toBe(1);
    expect(h.probes).toBe(0);
  });

  // risk: quit hangs/noise — no retries or recovery polling while the app is quitting
  it('does not retry or poll while shutting down', async() => {
    const h = new GuardHarness();
    h.shuttingDown = true;
    const down = h.flakyRead(99, pgError('57P03', 'the database system is shutting down'), ['x']);

    await expect(h.guard.run('functions-list', down.read, [])).resolves.toEqual([]);
    await h.guard.settled();

    expect(down.calls()).toBe(1);
    expect(h.sleeps).toEqual([]);
    expect(h.notified).toBe(0);
  });
});

// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// E9 db/auth characterization: the db.ts error classification, outage throttle and readiness retry must
// behave exactly like the frozen pre-refactor copy (Support/E9Legacy/db.legacy.ts) for the same inputs.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as current from '../../../../../../services/sulla-vault/src/db';
import * as legacy from '../../Support/E9Legacy/db.legacy';

class ErrnoFixture extends Error {
  readonly [key: string]: unknown;

  constructor(readonly code: string, extra: Readonly<Record<string, unknown>> = {}) {
    super(`${ code } failure`);
    Object.assign(this, extra);
  }
}

class ErrorTable {
  static readonly endpoints: readonly (string | undefined)[] = [
    undefined,
    'postgres://u:p@postgres:5432/sulla_vault',
    'postgres://u:p@postgres/sulla_vault',
    'postgres://u:p@[::1]:6543/sulla_vault',
    'postgres://u:p@127.0.0.1:5433/sulla_vault',
    'not a url',
    '',
  ];

  static cases(): Array<[string, unknown]> {
    const codes = ['57P01', '57P02', '57P03', '57P04', '08000', '08006', '08P01', '53300', '53400', '42P01', '23505', 'XX000', ''];
    const network = ['ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'EACCES'];
    const out: Array<[string, unknown]> = [
      ['null', null], ['undefined', undefined], ['string', 'ECONNRESET'], ['number', 42], ['empty object', {}],
      ['numeric code', { code: 57 }],
      ['plain message terminated', new Error('Connection terminated unexpectedly')],
      ['message closed', new Error('the connection was closed by peer')],
      ['message ended', new Error('Client CONNECTION has ended')],
      ['message timeout', new Error('timeout exceeded when trying to connect')],
      ['message other', new Error('relation "users" does not exist')],
      ['message non-string', { message: 5 }],
      ['empty errors array', { errors: [] }],
      ['aggregate all transient', { errors: [new ErrnoFixture('57P01'), new Error('Connection terminated')] }],
      ['aggregate mixed', { errors: [new ErrnoFixture('57P01'), new ErrnoFixture('42P01')] }],
      ['aggregate network to db', { errors: [new ErrnoFixture('ECONNREFUSED', { address: '127.0.0.1', port: 5432 }), new ErrnoFixture('ECONNREFUSED', { address: '::1', port: 5432 })] }],
      ['aggregate non-array', { errors: 'nope', message: 'x' }],
    ];
    for (const code of codes) out.push([`sql ${ code }`, new ErrnoFixture(code)]);
    for (const code of network) {
      out.push([`${ code } bare`, new ErrnoFixture(code)]);
      out.push([`${ code } hostname postgres`, new ErrnoFixture(code, { hostname: 'postgres' })]);
      out.push([`${ code } hostname ::1`, new ErrnoFixture(code, { hostname: '::1' })]);
      out.push([`${ code } hostname other`, new ErrnoFixture(code, { hostname: 'api.anthropic.com' })]);
      out.push([`${ code } port 5432`, new ErrnoFixture(code, { port: 5432 })]);
      out.push([`${ code } port 443`, new ErrnoFixture(code, { port: 443 })]);
      out.push([`${ code } port 6543`, new ErrnoFixture(code, { port: 6543 })]);
      out.push([`${ code } address postgres no port`, new ErrnoFixture(code, { address: 'postgres' })]);
      out.push([`${ code } address 127.0.0.1 no port`, new ErrnoFixture(code, { address: '127.0.0.1' })]);
      out.push([`${ code } address other port 5432`, new ErrnoFixture(code, { address: '10.0.0.9', port: 5432 })]);
      out.push([`${ code } address port string`, new ErrnoFixture(code, { address: 'postgres', port: '5432' })]);
      out.push([`${ code } hostname non-string`, new ErrnoFixture(code, { hostname: 7, port: 5432 })]);
    }
    return out;
  }
}

describe('E9 db.ts error helpers match the pre-refactor implementation', () => {
  afterEach(() => { delete process.env.SULLA_VAULT_DATABASE_URL; });

  it('classifies every error/endpoint combination exactly like legacy isTransientDbError', () => { // risk: outage handling (503 vs crash)
    const mismatches: string[] = [];
    let checked = 0;
    for (const endpoint of ErrorTable.endpoints) {
      if (endpoint === undefined) delete process.env.SULLA_VAULT_DATABASE_URL;
      else process.env.SULLA_VAULT_DATABASE_URL = endpoint;
      for (const [name, error] of ErrorTable.cases()) {
        checked++;
        const expected = legacy.isTransientDbError(error);
        if (current.isTransientDbError(error) !== expected) mismatches.push(`${ endpoint ?? '<unset>' } :: ${ name } (legacy ${ expected })`);
      }
    }
    expect(checked).toBeGreaterThan(700);
    expect(mismatches).toEqual([]);
  });

  it('pins known classifications', () => { // risk: outage handling
    process.env.SULLA_VAULT_DATABASE_URL = 'postgres://u:p@postgres:5432/sulla_vault';
    expect(current.isTransientDbError(new ErrnoFixture('EAI_AGAIN', { hostname: 'api.anthropic.com' }))).toBe(false);
    expect(current.isTransientDbError(new ErrnoFixture('EAI_AGAIN', { hostname: 'postgres' }))).toBe(true);
    expect(current.isTransientDbError(new ErrnoFixture('ETIMEDOUT', { address: '104.18.0.1', port: 443 }))).toBe(false);
    expect(current.isTransientDbError(new ErrnoFixture('ECONNRESET'))).toBe(true);
    expect(current.isTransientDbError(new ErrnoFixture('57P01'))).toBe(true);
    expect(current.isTransientDbError(new ErrnoFixture('42P01'))).toBe(false);
    expect(current.isTransientDbError({ errors: [] })).toBe(false);
  });

  it('describes errors exactly like legacy describeDbError', () => { // risk: log hygiene (never dump the pg object)
    const inputs: unknown[] = [
      null, undefined, {}, new Error(''), new Error('one line'), new Error('first\nsecond\nthird'),
      new ErrnoFixture('57P01'), Object.assign(new Error('multi\nline'), { code: '08006' }), { code: '', message: '' },
      { code: 'X' }, { message: '\nleading newline' },
    ];
    for (const input of inputs) expect(current.describeDbError(input)).toBe(legacy.describeDbError(input));
    expect(current.describeDbError(null)).toBe('unknown error');
    expect(current.describeDbError(Object.assign(new Error('multi\nline'), { code: '08006' }))).toBe('08006 multi');
  });
});

describe('E9 db.ts outage log throttle matches the pre-refactor implementation', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  class WarnTimeline {
    static run(warn: (error: unknown) => void): Array<[number, string]> {
      const seen: Array<[number, string]> = [];
      const spy = vi.spyOn(console, 'warn').mockImplementation((message: unknown) => { seen.push([Date.now(), String(message)]); });
      const start = 1_800_000_000_000;
      for (const offset of [0, 1, 29_999, 30_000, 30_001, 59_999, 60_000, 60_000, 200_000, 229_999, 230_000]) {
        vi.setSystemTime(start + offset);
        warn(Object.assign(new Error(`down at ${ offset }\nstack`), { code: '57P01' }));
      }
      spy.mockRestore();
      return seen.map(([at, message]) => [at - start, message]);
    }
  }

  it('logs at most once per 30s with the identical message', () => { // risk: log flood during an outage
    const expected = WarnTimeline.run(legacy.warnDatabaseUnavailable);
    const actual = WarnTimeline.run(current.warnDatabaseUnavailable);
    expect(actual).toEqual(expected);
    expect(actual).toEqual([
      [0, 'sulla-vault: Postgres unavailable, requests return 503 until it recovers (57P01 down at 0)'],
      [30_000, 'sulla-vault: Postgres unavailable, requests return 503 until it recovers (57P01 down at 30000)'],
      [60_000, 'sulla-vault: Postgres unavailable, requests return 503 until it recovers (57P01 down at 60000)'],
      [200_000, 'sulla-vault: Postgres unavailable, requests return 503 until it recovers (57P01 down at 200000)'],
      [230_000, 'sulla-vault: Postgres unavailable, requests return 503 until it recovers (57P01 down at 230000)'],
    ]);
  });
});

describe('E9 db.ts untilDatabaseReady matches the pre-refactor implementation', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  type Wait = <T>(label: string, operation: () => Promise<T>) => Promise<T>;

  class RetryScenario {
    constructor(private readonly failures: unknown[], private readonly finalOutcome: { value?: string; error?: unknown }) {}

    async run(wait: Wait) {
      const warnings: Array<[number, string]> = [];
      const spy = vi.spyOn(console, 'warn').mockImplementation((message: unknown) => { warnings.push([Date.now(), String(message)]); });
      const start = Date.now();
      const calls: number[] = [];
      let index = 0;
      const promise = wait('setup', async() => {
        calls.push(Date.now() - start);
        if (index < this.failures.length) throw this.failures[index++];
        if (this.finalOutcome.error) throw this.finalOutcome.error;
        return this.finalOutcome.value;
      });
      const settled = promise.then((value) => ({ value }), (error: unknown) => ({ error }));
      await vi.advanceTimersByTimeAsync(200_000);
      const outcome = await settled;
      spy.mockRestore();
      return { outcome, calls, warnings: warnings.map(([at, message]) => [at - start, message]) };
    }
  }

  it('retries transient failures with the same backoff, logs and result', async() => { // risk: startup hang or crash loop
    const failures = Array.from({ length: 13 }, (_, i) => (i % 2 ? new Error('Connection terminated unexpectedly') : Object.assign(new Error('admin shutdown'), { code: '57P01' })));
    const scenario = new RetryScenario(failures, { value: 'ready' });
    const expected = await scenario.run(legacy.untilDatabaseReady);
    const actual = await new RetryScenario(failures, { value: 'ready' }).run(current.untilDatabaseReady);
    expect(actual).toEqual(expected);
    expect(actual.outcome).toEqual({ value: 'ready' });
    expect(actual.calls.slice(0, 7)).toEqual([0, 500, 1500, 3500, 7500, 12_500, 17_500]);
    expect(actual.warnings.map(([, message]) => message)).toEqual([
      'sulla-vault: waiting for Postgres during setup (attempt 1, 57P01 admin shutdown); retrying every 0.5s',
      'sulla-vault: waiting for Postgres during setup (attempt 12, Connection terminated unexpectedly); retrying every 5s',
    ]);
  });

  it('rethrows a non-transient error immediately, the same object', async() => { // risk: masking real SQL errors
    const fatal = Object.assign(new Error('syntax error'), { code: '42601' });
    const expected = await new RetryScenario([Object.assign(new Error('x'), { code: '08006' })], { error: fatal }).run(legacy.untilDatabaseReady);
    const actual = await new RetryScenario([Object.assign(new Error('x'), { code: '08006' })], { error: fatal }).run(current.untilDatabaseReady);
    expect(actual).toEqual(expected);
    expect((actual.outcome as { error: unknown }).error).toBe(fatal);
    expect(actual.calls).toEqual([0, 500]);
  });
});

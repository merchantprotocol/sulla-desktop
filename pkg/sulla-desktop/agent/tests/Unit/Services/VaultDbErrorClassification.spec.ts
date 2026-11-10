// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { afterEach, describe, expect, it } from 'vitest';

import { isTransientDbError } from '../../../../../../services/sulla-vault/src/db';
import { describeUpstreamError, isUpstreamNetworkError } from '../../../../../../services/sulla-vault/src/upstreamEgress';

class ErrnoFixture extends Error {
  readonly [key: string]: unknown;
  readonly code: string;

  constructor(code: string, extra: Readonly<Record<string, unknown>> = {}) {
    super(`${ code } failure`);
    this.code = code;
    Object.assign(this, extra);
  }
}

describe('vault database error classification', () => {
  afterEach(() => { delete process.env.SULLA_VAULT_DATABASE_URL; });

  it('does not treat an upstream DNS failure as a Postgres outage', () => {
    process.env.SULLA_VAULT_DATABASE_URL = 'postgres://u:p@postgres:5432/sulla_vault';
    const dns = new ErrnoFixture('EAI_AGAIN', { syscall: 'getaddrinfo', hostname: 'api.anthropic.com' });
    expect(isTransientDbError(dns)).toBe(false);
    expect(isUpstreamNetworkError(dns)).toBe(true);
    // undici wraps the socket error in `TypeError: fetch failed`.
    const wrapped = Object.assign(new TypeError('fetch failed'), { cause: dns });
    expect(isTransientDbError(wrapped)).toBe(false);
    expect(isUpstreamNetworkError(wrapped)).toBe(true);
    expect(describeUpstreamError(wrapped).code).toBe('EAI_AGAIN');
  });

  it('does not treat upstream connect errors to another host or port as database errors', () => {
    process.env.SULLA_VAULT_DATABASE_URL = 'postgres://u:p@postgres:5432/sulla_vault';
    expect(isTransientDbError(new ErrnoFixture('ETIMEDOUT', { syscall: 'connect', address: '104.18.0.1', port: 443 }))).toBe(false);
    expect(isTransientDbError(new ErrnoFixture('ECONNRESET', { syscall: 'read' }))).toBe(true);
  });

  it('still classifies Postgres-originated failures as database_unavailable', () => {
    process.env.SULLA_VAULT_DATABASE_URL = 'postgres://u:p@postgres:5432/sulla_vault';
    expect(isTransientDbError(new ErrnoFixture('57P01'))).toBe(true);
    expect(isTransientDbError(new ErrnoFixture('08006'))).toBe(true);
    expect(isTransientDbError(new ErrnoFixture('53300'))).toBe(true);
    expect(isTransientDbError(new Error('timeout exceeded when trying to connect'))).toBe(true);
    expect(isTransientDbError(new Error('Connection terminated unexpectedly'))).toBe(true);
    expect(isTransientDbError(new ErrnoFixture('ECONNREFUSED', { syscall: 'connect', address: '172.18.0.2', port: 5432 }))).toBe(true);
    expect(isTransientDbError(new ErrnoFixture('EAI_AGAIN', { syscall: 'getaddrinfo', hostname: 'postgres' }))).toBe(true);
  });

  it('keeps the permissive behavior while the endpoint is unknown', () => {
    expect(isTransientDbError(new ErrnoFixture('ECONNREFUSED'))).toBe(true);
  });

  it('does not flag plain SQL errors', () => {
    expect(isTransientDbError(new ErrnoFixture('42P01'))).toBe(false);
  });
});

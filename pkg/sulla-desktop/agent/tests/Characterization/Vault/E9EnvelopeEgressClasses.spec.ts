// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// E9: the new classes behind the deprecated aliases (CloudSyncRoutes,
// PostgresSyncSchemaRepository + SyncSchemaInitializer, UpstreamEgressDiagnostics)
// used directly must behave exactly like the verbatim legacy copies.

import { describe, expect, it } from 'vitest';

import { CloudSyncRoutes } from '../../../../../../services/sulla-vault/src/browserEnvelope/CloudSyncRoutes';
import { CloudSyncError } from '../../../../../../services/sulla-vault/src/browserEnvelope/syncRunner';
import { PostgresSyncSchemaRepository, SYNC_SCHEMA_SQL } from '../../../../../../services/sulla-vault/src/browserEnvelope/sync/repositories/PostgresSyncSchemaRepository';
import { SyncSchemaInitializer } from '../../../../../../services/sulla-vault/src/browserEnvelope/sync/SyncSchemaInitializer';
import { UpstreamEgressDiagnostics } from '../../../../../../services/sulla-vault/src/UpstreamEgressDiagnostics';
import { registerCloudSyncRoutes as legacyRegisterCloudSyncRoutes } from '../../Support/E9Legacy/routes.legacy';
import { SYNC_SCHEMA_SQL as LEGACY_SYNC_SCHEMA_SQL } from '../../Support/E9Legacy/schema.legacy';
import * as legacyEgress from '../../Support/E9Legacy/upstreamEgress.legacy';

type RouteHandler = (request: unknown, response: unknown) => Promise<void>;

class RouteProbe {
  readonly posts: Array<{ path: string; handler: RouteHandler }> = [];
  readonly answers: Array<[string, unknown]> = [];
  readonly runnerCalls: Array<[string, unknown[]]> = [];

  app() {
    return { post: (path: string, handler: RouteHandler) => { this.posts.push({ path, handler }); } };
  }

  runner(fail: unknown) {
    const call = (name: string, args: unknown[]) => {
      this.runnerCalls.push([name, args]);
      return fail === null ? Promise.resolve({ name }) : Promise.reject(fail);
    };
    return {
      status: () => call('status', []), pull: (d: unknown) => call('pull', [d]),
      prepare: (o: unknown, d: unknown) => call('prepare', [o, d]), send: (h: unknown, s: unknown) => call('send', [h, s]),
      heldList: () => call('heldList', []), heldApprove: (r: unknown) => call('heldApprove', [r]),
      heldReject: (r: unknown) => call('heldReject', [r]), forget: () => call('forget', []),
    };
  }

  response() {
    const res = {
      status: (code: number) => { this.answers.push(['status', code]); return res; },
      json: (body: unknown) => { this.answers.push(['json', body]); return res; },
    };
    return res;
  }

  async hitAll(body: unknown) {
    for (const route of this.posts) await route.handler({ body }, this.response());
    return { paths: this.posts.map(route => route.path), answers: this.answers, runnerCalls: this.runnerCalls };
  }
}

const BODIES = [
  undefined,
  { deviceId: 'device-0123', op: 'commit', handle: 'h1', ts: '5', signature: 's', recordId: '30000000-0000-4000-8000-00000000000a' },
  { deviceId: 'bad', op: 'nope', handle: 'h'.repeat(65), recordId: 'x' },
];
const FAILURES: unknown[] = [null, new CloudSyncError('conflict', 409, 'moved'), new Error('x'), { status: 451, code: 'legal' }];

describe('E9 new classes equal legacy behaviour', () => {
  it('CloudSyncRoutes registered directly answers like the legacy module', async() => {
    // risk: authority — direct use of the class must not differ from the alias.
    for (const body of BODIES) {
      for (const failure of FAILURES) {
        for (const identityFails of [false, true]) {
          const identity = () => { if (identityFails) throw new CloudSyncError('forbidden', 403, 'no'); };
          const legacy = new RouteProbe();
          legacyRegisterCloudSyncRoutes(legacy.app() as never, legacy.runner(failure) as never, identity);
          const current = new RouteProbe();
          new CloudSyncRoutes(current.runner(failure) as never, identity).register(current.app() as never);
          expect(await current.hitAll(body)).toEqual(await legacy.hitAll(body));
        }
      }
    }
  });

  it('PostgresSyncSchemaRepository applies the character-identical SQL through the given client', async() => {
    // risk: data integrity — the moved SQL must be exactly the legacy schema.
    expect(SYNC_SCHEMA_SQL).toBe(LEGACY_SYNC_SCHEMA_SQL);
    const calls: unknown[][] = [];
    await new PostgresSyncSchemaRepository().apply({ query: async(...args: unknown[]) => { calls.push(args); return { rows: [] }; } } as never);
    expect(calls).toEqual([[LEGACY_SYNC_SCHEMA_SQL]]);
  });

  it('SyncSchemaInitializer applies once per instance and retries after a failure', async() => {
    // risk: data integrity — a failed create must not be remembered; state is per instance.
    const applied: unknown[] = [];
    let failNext = true;
    const repository = {
      apply: async(db: unknown) => {
        applied.push(db);
        if (failNext) { failNext = false; throw new Error('db down'); }
      },
    } as unknown as PostgresSyncSchemaRepository;
    const initializer = new SyncSchemaInitializer(repository);
    const db = { query: async() => ({ rows: [] }) };
    await expect(initializer.ensure(db as never)).rejects.toThrow('db down');
    await initializer.ensure(db as never);
    await initializer.ensure(db as never);
    expect(applied).toEqual([db, db]);

    const other = new SyncSchemaInitializer(repository);
    await other.ensure(db as never);
    expect(applied).toHaveLength(3);
  });

  it('UpstreamEgressDiagnostics methods equal the legacy functions', () => {
    // risk: retry safety + leakage — direct use of the class must not differ from the aliases.
    const diagnostics = new UpstreamEgressDiagnostics();
    const errors: unknown[] = [
      null, { code: 'ECONNRESET' }, { code: 'ENOTFOUND' }, { code: 'EACCES' },
      new TypeError('fetch failed', { cause: { code: 'EAI_AGAIN' } }),
      { errors: [{ code: 'ENETUNREACH', address: '::1' }, { code: 'ETIMEDOUT', address: '192.0.2.1' }] },
      { code: 'CERT_HAS_EXPIRED', syscall: 'connect', address: '192.0.2.1' },
    ];
    for (const error of errors) {
      expect(diagnostics.isNetworkError(error)).toBe(legacyEgress.isUpstreamNetworkError(error));
      expect(diagnostics.describe(error)).toEqual(legacyEgress.describeUpstreamError(error));
      expect(diagnostics.isReconnectable(error, false)).toBe(legacyEgress.isReconnectableUpstreamError(error, false));
      expect(diagnostics.isReconnectable(error, true)).toBe(legacyEgress.isReconnectableUpstreamError(error, true));
    }
    for (const code of ['EAI_AGAIN', 'ERR_TLS_X', 'ECONNRESET', 'bad code!']) {
      expect(diagnostics.failurePhase(code, false)).toBe(legacyEgress.upstreamFailurePhase(code, false));
      expect(diagnostics.failurePhase(code, true)).toBe(legacyEgress.upstreamFailurePhase(code, true));
      expect(diagnostics.failureReason('tls', code)).toBe(legacyEgress.upstreamFailureReason('tls', code));
    }
    const addresses = [{ address: '::1', family: 6 as const }, { address: '127.0.0.1', family: 4 as const }];
    expect(diagnostics.retryAddressOrder(addresses, ['v6:ENETUNREACH'])).toEqual(legacyEgress.retryAddressOrder(addresses, ['v6:ENETUNREACH']));
    expect(diagnostics.retryAddressOrder(addresses, ['v6:ENETUNREACH'])).toEqual([addresses[1], addresses[0]]);
    expect(diagnostics.familySummary(addresses)).toBe(legacyEgress.familySummary(addresses));
    const entry = {
      operation: 'op', hostname: 'h.test', attempt: 1, maxAttempts: 3, phase: 'dns' as const,
      detail: { code: 'EAI_AGAIN', attempts: [] }, families: 'none', reusedSocket: false, willRetry: true,
    };
    expect(diagnostics.formatFailureLog(entry)).toBe(legacyEgress.formatUpstreamFailureLog(entry));
  });
});

// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// E9 characterization: the Passwords sync v3 Desktop control routes must answer
// every request (status code, body, runner call, identity check) exactly as the
// verbatim legacy copy of browserEnvelope/routes.ts at ddbe28884 does.

import { describe, expect, it } from 'vitest';

import { EnvelopeError } from '../../../../../../services/sulla-vault/src/browserEnvelope/envelope';
import { registerCloudSyncRoutes } from '../../../../../../services/sulla-vault/src/browserEnvelope/routes';
import { CloudSyncError } from '../../../../../../services/sulla-vault/src/browserEnvelope/syncRunner';
import { registerCloudSyncRoutes as legacyRegisterCloudSyncRoutes } from '../../Support/E9Legacy/routes.legacy';

type RouteHandler = (request: unknown, response: unknown) => Promise<void>;
type Register = (app: never, runner: never, requireDesktopIdentity: never) => void;

class RecordingApp {
  readonly routes: Array<{ path: string; handler: RouteHandler }> = [];

  post(path: string, handler: RouteHandler): this {
    this.routes.push({ path, handler });
    return this;
  }

  handler(path: string): RouteHandler {
    const route = this.routes.find(entry => entry.path === path);
    if (!route) throw new Error(`route not registered: ${ path }`);
    return route.handler;
  }
}

class RecordingResponse {
  readonly calls: Array<[string, unknown]> = [];

  status(code: number): this {
    this.calls.push(['status', code]);
    return this;
  }

  json(body: unknown): this {
    this.calls.push(['json', body]);
    return this;
  }
}

type Outcome =
  | { kind: 'resolve'; value: unknown }
  | { kind: 'reject'; error: () => unknown }
  | { kind: 'syncThrow'; error: () => unknown };

class FakeRunner {
  readonly calls: Array<[string, unknown[]]> = [];

  constructor(private readonly outcome: Outcome) {}

  status() { return this.run('status', []); }
  pull(deviceId: unknown) { return this.run('pull', [deviceId]); }
  prepare(op: unknown, deviceId: unknown) { return this.run('prepare', [op, deviceId]); }
  send(handle: unknown, signature: unknown) { return this.run('send', [handle, signature]); }
  heldList() { return this.run('heldList', []); }
  heldApprove(recordId: unknown) { return this.run('heldApprove', [recordId]); }
  heldReject(recordId: unknown) { return this.run('heldReject', [recordId]); }
  forget() { return this.run('forget', []); }

  private run(name: string, args: unknown[]): Promise<unknown> {
    this.calls.push([name, args]);
    if (this.outcome.kind === 'syncThrow') throw this.outcome.error();
    if (this.outcome.kind === 'reject') return Promise.reject(this.outcome.error());
    return Promise.resolve(this.outcome.value);
  }
}

type IdentityBehaviour = 'allow' | 'cloudSyncError' | 'statusObject' | 'plainError';

class IdentityProbe {
  readonly calls: Array<{ sameRequest: boolean; thisValue: unknown }> = [];

  constructor(private readonly behaviour: IdentityBehaviour) {}

  create(expectedRequest: unknown): (request: unknown) => void {
    const probe = this;
    return function requireDesktopIdentity(this: unknown, request: unknown) {
      probe.calls.push({ sameRequest: request === expectedRequest, thisValue: this });
      if (probe.behaviour === 'cloudSyncError') throw new CloudSyncError('forbidden', 403, 'Desktop identity required');
      if (probe.behaviour === 'statusObject') throw { status: 401, code: 'unauthorized' };
      if (probe.behaviour === 'plainError') throw new Error('identity store offline');
    };
  }
}

interface Scenario {
  path: string;
  body: unknown;
  outcome: Outcome;
  identity: IdentityBehaviour;
}

class RouteHarness {
  static async run(register: Register, scenario: Scenario) {
    const app = new RecordingApp();
    const runner = new FakeRunner(scenario.outcome);
    const identity = new IdentityProbe(scenario.identity);
    const request = { body: scenario.body };
    register(app as never, runner as never, identity.create(request) as never);
    const response = new RecordingResponse();
    let escaped: unknown = null;
    try {
      await app.handler(`/v1/desktop/cloud-sync/${ scenario.path }`)(request, response);
    } catch (error) {
      escaped = error;
    }
    return {
      paths:         app.routes.map(route => route.path),
      response:      response.calls,
      runner:        runner.calls,
      identity:      identity.calls,
      escaped,
    };
  }
}

const PATHS = ['status', 'pull', 'prepare', 'send', 'held/list', 'held/approve', 'held/reject', 'forget'];
const RECORD_ID = '30000000-0000-4000-8000-00000000000a';

const BODIES: unknown[] = [
  undefined,
  null,
  {},
  { deviceId: 'device-0123', op: 'commit', handle: 'handle-1', ts: '1700000000', signature: 'sig', recordId: RECORD_ID },
  { deviceId: 'device-0123', op: 'enable', handle: 'h'.repeat(64), ts: 12, signature: { nested: true }, recordId: RECORD_ID.toUpperCase() },
  { deviceId: 'Dev_ice.ID-9', op: 'replace' },
  { deviceId: 'a'.repeat(128), op: 'rewrap' },
  { deviceId: 'a'.repeat(129), op: 'pause' },
  { deviceId: 'short', op: 'resume' },
  { deviceId: 'device 0123', op: 'delete' },
  { deviceId: 12345678, op: 'commit' },
  { deviceId: 'device-0123', op: 'explode' },
  { deviceId: 'device-0123', op: '__proto__' },
  { deviceId: 'device-0123', op: 'COMMIT' },
  { deviceId: 'short', op: 'explode' },
  { handle: 'h'.repeat(65), ts: 'not-a-number' },
  { handle: 42 },
  { handle: '' },
  { recordId: 'not-a-uuid' },
  { recordId: `${ RECORD_ID }0` },
  { recordId: 7 },
];

const ERRORS: Array<() => unknown> = [
  () => new CloudSyncError('sync_conflict', 409, 'Cloud head moved'),
  () => new CloudSyncError('not_enabled', 404, 'Sync is not enabled'),
  () => new EnvelopeError('mac_mismatch', 'record MAC did not verify'),
  () => new EnvelopeError('head_rollback'),
  () => Object.assign(new Error('upstream'), { status: 502, code: 'upstream_unavailable' }),
  () => Object.assign(new Error('weird'), { status: '503', code: 'string_status' }),
  () => Object.assign(new Error('codeless'), { status: 418 }),
  () => new Error('plain failure'),
  () => ({ code: 'object_code' }),
  () => null,
  () => undefined,
  () => 'boom',
];

const OUTCOMES: Outcome[] = [
  { kind: 'resolve', value: { ok: true, handle: 'abc', sha256: 'f'.repeat(64) } },
  { kind: 'resolve', value: undefined },
  { kind: 'resolve', value: [] },
  ...ERRORS.map(error => ({ kind: 'reject' as const, error })),
  ...ERRORS.slice(0, 3).map(error => ({ kind: 'syncThrow' as const, error })),
];

describe('E9 browserEnvelope routes: behaviour equals legacy copy', () => {
  it('registers the same eight POST paths in the same order', async() => {
    // risk: authority — a missing or renamed route silently disables sync controls.
    const scenario: Scenario = { path: 'status', body: {}, outcome: OUTCOMES[0], identity: 'allow' };
    const legacy = await RouteHarness.run(legacyRegisterCloudSyncRoutes as Register, scenario);
    const current = await RouteHarness.run(registerCloudSyncRoutes as Register, scenario);
    expect(current.paths).toEqual(legacy.paths);
    expect(current.paths).toEqual(PATHS.map(path => `/v1/desktop/cloud-sync/${ path }`));
  });

  for (const path of PATHS) {
    it(`answers ${ path } identically for every body and runner outcome`, async() => {
      // risk: authority + leakage — status codes, error codes and validation must not drift.
      for (const [bodyIndex, body] of BODIES.entries()) {
        for (const [outcomeIndex, outcome] of OUTCOMES.entries()) {
          const scenario: Scenario = { path, body, outcome, identity: 'allow' };
          const legacy = await RouteHarness.run(legacyRegisterCloudSyncRoutes as Register, scenario);
          const current = await RouteHarness.run(registerCloudSyncRoutes as Register, scenario);
          expect(current, `${ path } body#${ bodyIndex } outcome#${ outcomeIndex }`).toEqual(legacy);
        }
      }
    });
  }

  for (const identity of ['cloudSyncError', 'statusObject', 'plainError'] as const) {
    it(`refuses every path identically when the identity check fails (${ identity })`, async() => {
      // risk: authority — no runner call may happen before the Desktop identity passes.
      for (const path of PATHS) {
        const scenario: Scenario = { path, body: BODIES[3], outcome: OUTCOMES[0], identity };
        const legacy = await RouteHarness.run(legacyRegisterCloudSyncRoutes as Register, scenario);
        const current = await RouteHarness.run(registerCloudSyncRoutes as Register, scenario);
        expect(current, `${ path } ${ identity }`).toEqual(legacy);
        expect(current.runner).toEqual([]);
      }
    });
  }

  it('pins the externally visible answers', async() => {
    // risk: authority + leakage — known status/body pairs callers depend on.
    const run = (scenario: Scenario) => RouteHarness.run(registerCloudSyncRoutes as Register, scenario);
    const ok: Outcome = { kind: 'resolve', value: { done: 1 } };
    const valid = BODIES[3];

    expect((await run({ path: 'status', body: undefined, outcome: ok, identity: 'allow' })).response)
      .toEqual([['json', { done: 1 }]]);
    expect((await run({ path: 'forget', body: undefined, outcome: ok, identity: 'allow' })).response)
      .toEqual([['json', { ok: true }]]);
    expect((await run({ path: 'held/list', body: undefined, outcome: { kind: 'resolve', value: ['x'] }, identity: 'allow' })).response)
      .toEqual([['json', { held: ['x'] }]]);
    expect((await run({ path: 'pull', body: { deviceId: 'short' }, outcome: ok, identity: 'allow' })).response)
      .toEqual([['status', 400], ['json', { error: 'invalid_device', message: 'deviceId is required' }]]);
    expect((await run({ path: 'prepare', body: { deviceId: 'short', op: 'explode' }, outcome: ok, identity: 'allow' })).response)
      .toEqual([['status', 400], ['json', { error: 'invalid_operation', message: 'Unknown sync operation' }]]);
    expect((await run({ path: 'send', body: { handle: 'h'.repeat(65) }, outcome: ok, identity: 'allow' })).response)
      .toEqual([['status', 400], ['json', { error: 'invalid_handle', message: 'handle is required' }]]);
    expect((await run({ path: 'held/approve', body: { recordId: 'nope' }, outcome: ok, identity: 'allow' })).response)
      .toEqual([['status', 400], ['json', { error: 'invalid_record', message: 'recordId is required' }]]);
    expect((await run({ path: 'pull', body: valid, outcome: { kind: 'reject', error: ERRORS[2] }, identity: 'allow' })).response)
      .toEqual([['status', 409], ['json', { error: 'integrity_failed', reason: 'mac_mismatch', message: 'record MAC did not verify' }]]);
    expect((await run({ path: 'pull', body: valid, outcome: { kind: 'reject', error: ERRORS[7] }, identity: 'allow' })).response)
      .toEqual([['status', 500], ['json', { error: 'cloud_sync_failed' }]]);
    expect((await run({ path: 'status', body: valid, outcome: ok, identity: 'statusObject' })).response)
      .toEqual([['status', 401], ['json', { error: 'unauthorized' }]]);

    const send = await run({ path: 'send', body: valid, outcome: ok, identity: 'allow' });
    expect(send.runner).toEqual([['send', ['handle-1', { ts: 1700000000, signature: 'sig' }]]]);
    // The identity check is called as a plain function (no receiver), with the request itself.
    expect(send.identity).toEqual([{ sameRequest: true, thisValue: undefined }]);
  });
});

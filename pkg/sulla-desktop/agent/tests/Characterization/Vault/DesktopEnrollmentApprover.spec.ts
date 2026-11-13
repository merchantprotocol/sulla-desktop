// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// Characterization of the Desktop vault enrollment APPROVER (this trusted computer lets another device
// join its vault). Pins the 15 s poll, the human tap before any response, the broker wrap call and the
// signed Cloud bytes, so moving the code onto @sulla/domain cannot change them. Synthetic data only.

import crypto from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DesktopEnrollmentHarness } from '../../Support/Vault/DesktopEnrollmentHarness';
import { Deferred, FakeEnrollmentCloud, FakeVaultBroker, FixedDeviceKeyDir } from '../../Support/Vault/EnrollmentFakes';
import { DesktopDeviceIdentity } from '../../../../main/cloud/device/DesktopDeviceIdentity';

const env = vi.hoisted(() => ({
  cloud: null as any, broker: null as any, userId: 'user-0001', deviceDir: '', timeline: [] as string[],
  prompt: null as null | ((options: { buttons: string[] }) => Promise<{ response: number }>),
}));

vi.mock('@pkg/utils/paths', () => ({ default: { get sullaConfig() { return env.deviceDir } } }));
vi.mock('../../../../main/deviceIdentity', () => ({ getDesktopDeviceId: async() => 'device-0001', readExistingDesktopDeviceId: () => 'device-0001' }));
vi.mock('../../../../main/sullaCloudAuth', () => ({ getCurrentUserId: async() => env.userId }));
vi.mock('../../../../main/cloud/cloudFetch', () => ({
  cloudRequest: (method: string, url: string, options: any) => {
    env.timeline.push(`cloud:${ method } ${ new URL(url, 'https://cloud.test').pathname.split('/').pop() }`);
    return env.cloud.request(method, url, options);
  },
}));
vi.mock('@pkg/vault-broker', () => ({ getConfiguredApprovalClient: () => env.broker }));
vi.mock('@pkg/sulla', () => ({ onVaultUnlocked: async() => undefined }));
vi.mock('electron', () => ({
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  dialog: {
    showMessageBox: (...args: any[]) => {
      env.timeline.push('prompt');
      return env.prompt!(args[args.length - 1]);
    },
  },
}));

const VAULT = '11111111-2222-4333-8444-555555555555';
const T0 = 1_770_000_000_000;
const ALLOW = async() => ({ response: 0 });
const NOT_NOW = async() => ({ response: 1 });

let keyDir: FixedDeviceKeyDir;
let cloud: FakeEnrollmentCloud;
let broker: FakeVaultBroker;
let subject: DesktopEnrollmentHarness;

const sha = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
/** A well-formed raw P-256 point (65 bytes, base64url), as Cloud's validEnrollmentKey requires. */
const publicKeyFor = (id: string) => Buffer.concat([Buffer.from([4]), crypto.createHash('sha256').update(`${ id }x`).digest(), crypto.createHash('sha256').update(`${ id }y`).digest()]).toString('base64url');
const request = (id: string) => ({
  id, requesterType: 'desktop', requesterId: `requester-${ id }`, publicKey: publicKeyFor(id), nonce: 'nonce', expiresAt: '2026-11-12T00:05:00Z', createdAt: '2026-11-12T00:00:00Z',
});

/** Yields in real time until `done()` holds (the poll runs on real promises under fake timers). */
async function until(done: () => boolean): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!done()) {
    if (performance.now() > deadline) throw new Error('condition never held');
    await new Promise(resolve => setImmediate(resolve));
  }
}

/** Lets an in-flight poll finish: waits until the timeline stops growing for a few turns. */
async function settle(): Promise<void> {
  let quiet = 0;
  let length = -1;
  while (quiet < 50) {
    quiet = env.timeline.length === length ? quiet + 1 : 0;
    length = env.timeline.length;
    await new Promise(resolve => setImmediate(resolve));
  }
}

beforeEach(async() => {
  vi.useFakeTimers({ now: T0, toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  keyDir = new FixedDeviceKeyDir();
  DesktopDeviceIdentity.useInstance(null); // the identity is process-wide; rebuild it over this test's dir
  env.deviceDir = keyDir.dir;
  env.userId = 'user-0001';
  env.timeline = [];
  env.prompt = ALLOW;
  env.cloud = cloud = new FakeEnrollmentCloud(VAULT);
  env.broker = broker = new FakeVaultBroker(env.timeline);
  vi.resetModules();
  subject = await DesktopEnrollmentHarness.load();
});

afterEach(() => {
  subject.stopApprover();
  vi.useRealTimers();
  keyDir.remove();
});

describe('vault enrollment approver', () => {
  it('asks a human, then fetches bundle and records, wraps in the broker and responds, in that order', async() => {
    cloud.listReply = { status: 200, body: { requests: [request('req-a')] } };
    subject.startApprover();
    await until(() => cloud.callsTo('/respond').length === 1);

    const order = env.timeline.filter(event => !event.startsWith('legacy:'));
    expect(order.slice(0, 3)).toEqual(['cloud:GET status', 'cloud:GET requests', 'prompt']);
    expect(order.slice(3, 5).sort()).toEqual(['cloud:GET bundle', 'cloud:GET records']);
    expect(order.slice(5)).toEqual(['wrap', 'cloud:POST respond']);

    expect(broker.wrapCalls).toEqual([{
      requestId: 'req-a', vaultId: VAULT, vaultEpoch: 3, publicKey: publicKeyFor('req-a'),
      bundle: { epoch: 3, mac: 'bundle-mac' }, head: { mac: 'head-mac', vaultId: VAULT }, records: [{ id: 'r1' }], approved: true,
    }]);
    const [respond] = cloud.callsTo('/respond');
    expect(respond.path).toBe(`/cloud-vault-sync/vaults/${ VAULT }/enrollment/requests/req-a/respond`);
    expect(respond.body).toBe(JSON.stringify({ wrappedUserKey: broker.wrapResult.wrappedUserKey }));
    expect(respond.headers['Content-Type']).toBe('application/json');
    const ts = respond.headers['X-Sulla-Timestamp'];
    expect(ts).toBe('1770000000'); // risk: Cloud rejects a millisecond timestamp
    const message = ['sulla-vault-sync-v3', 'user-0001', 'device-0001', VAULT, 'enrollment-respond:req-a', sha(respond.body!), ts].join('\n');
    expect(FixedDeviceKeyDir.verify(message, respond.headers['X-Sulla-Device-Signature'])).toBe(true);
  });

  it('signs the request list with the known-answer signature (seconds, empty-body hash)', async() => {
    subject.startApprover();
    await until(() => cloud.callsTo('/enrollment/requests', 'GET').length === 1);
    const [list] = cloud.callsTo('/enrollment/requests', 'GET');
    expect(list.path).toBe(`/cloud-vault-sync/vaults/${ VAULT }/enrollment/requests`);
    expect(list.query.get('deviceId')).toBe('device-0001');
    expect(list.body).toBeUndefined();
    expect(list.headers['X-Sulla-Timestamp']).toBe('1770000000');
    expect(list.headers['X-Sulla-Device-Signature']).toBe('Em9ml/0svPPtRMUFZnIYke2FUECebKFj7gJ+uYs7x9MC9OpoE6k5VtSEo/9TA4zFM/vwCKzUOBa+jSdcK7FNDg==');
  });

  it('denies a declined request on Cloud once, signed, and never prompts for it again', async() => {
    // risk: auth — a declined device must be ended on Cloud, and only by this device's signed call after the tap
    cloud.listReply = { status: 200, body: { requests: [request('req-a')] } };
    env.prompt = NOT_NOW;
    subject.startApprover();
    await until(() => cloud.callsTo('/deny').length === 1);
    await settle();
    await vi.advanceTimersByTimeAsync(15_000);
    await settle();
    expect(env.timeline.filter(event => event === 'prompt')).toHaveLength(1);
    expect(cloud.calls.filter(call => call.method !== 'GET').map(call => call.path)).toEqual([
      `/cloud-vault-sync/vaults/${ VAULT }/enrollment/requests/req-a/deny`,
    ]);
    const [deny] = cloud.callsTo('/deny');
    expect(deny.query.get('deviceId')).toBe('device-0001');
    expect(deny.body).toBe(JSON.stringify({ reason: 'user_denied' }));
    const ts = deny.headers['X-Sulla-Timestamp'];
    const message = ['sulla-vault-sync-v3', 'user-0001', 'device-0001', VAULT, 'enrollment-deny:req-a', sha(deny.body!), ts].join('\n');
    expect(FixedDeviceKeyDir.verify(message, deny.headers['X-Sulla-Device-Signature'])).toBe(true);
    expect(broker.wrapCalls).toEqual([]);
    expect(cloud.callsTo('/bundle')).toEqual([]);
    expect(cloud.callsTo('/respond')).toEqual([]);
  });

  it.each([
    ['a Cloud without the deny route (404)', { status: 404, body: { error: 'not_found' } }],
    ['a failing deny (500)', { status: 500, body: { error: 'internal_error' } }],
  ])('after %s: no retry, no re-prompt, and the next request is still offered', async(_label, reply) => {
    // risk: availability — an old or failing Cloud must not turn a decline into an error loop
    cloud.listReply = { status: 200, body: { requests: [request('req-a')] } };
    cloud.denyReply = reply;
    env.prompt = NOT_NOW;
    subject.startApprover();
    await until(() => cloud.callsTo('/deny').length === 1);
    await settle();
    cloud.listReply = { status: 200, body: { requests: [request('req-a'), request('req-b')] } };
    env.prompt = ALLOW;
    await vi.advanceTimersByTimeAsync(15_000);
    await until(() => cloud.callsTo('/respond').length === 1);
    await settle();
    expect(cloud.callsTo('/deny')).toHaveLength(1);
    expect(env.timeline.filter(event => event === 'prompt')).toHaveLength(2);
    expect(cloud.callsTo('/respond')[0].path.split('/').at(-2)).toBe('req-b');
  });

  it('touches no vault data while the prompt is still open', async() => {
    cloud.listReply = { status: 200, body: { requests: [request('req-a')] } };
    const tap = new Deferred<{ response: number }>();
    env.prompt = () => tap.promise;
    subject.startApprover();
    await until(() => env.timeline.includes('prompt'));
    await settle();
    expect(cloud.callsTo('/bundle')).toEqual([]);
    expect(cloud.callsTo('/respond')).toEqual([]);
    expect(broker.wrapCalls).toEqual([]);
    tap.resolve({ response: 0 });
    await until(() => cloud.callsTo('/respond').length === 1);
  });

  it('approves at most one request per poll and takes the next one 15 s later', async() => {
    cloud.listReply = { status: 200, body: { requests: [request('req-a'), request('req-b')] } };
    subject.startApprover();
    await until(() => cloud.callsTo('/respond').length === 1);
    await settle();
    expect(cloud.callsTo('/respond').map(call => call.path.split('/').at(-2))).toEqual(['req-a']);
    expect(env.timeline.filter(event => event === 'prompt')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(15_000);
    await until(() => cloud.callsTo('/respond').length === 2);
    expect(cloud.callsTo('/respond').map(call => call.path.split('/').at(-2))).toEqual(['req-a', 'req-b']);
  });

  it('does not list requests when this computer has no enabled Cloud vault', async() => {
    cloud.status = { status: 200, body: { enabled: false } };
    subject.startApprover();
    await until(() => cloud.callsTo('/status').length === 1);
    await settle();
    expect(cloud.callsTo('/enrollment/requests')).toEqual([]);
    expect(env.timeline).not.toContain('prompt');
  });

  it('runs the legacy password device-approval check before the enrollment list', async() => {
    subject.startApprover();
    await until(() => cloud.callsTo('/enrollment/requests', 'GET').length === 1);
    expect(env.timeline[0]).toBe('legacy:GET /auth/password/device-approval/requests');
  });

  it('falls back to the bundle epoch when the vault status has none', async() => {
    cloud.status = { status: 200, body: { enabled: true, vaultId: VAULT } };
    cloud.bundleReply = { status: 200, body: { bundle: { epoch: 9, mac: 'bundle-mac' } } };
    cloud.listReply = { status: 200, body: { requests: [request('req-a')] } };
    subject.startApprover();
    await until(() => broker.wrapCalls.length === 1);
    expect(broker.wrapCalls[0].vaultEpoch).toBe(9);
  });

  it('forgets declined requests when stopped, so a restart asks again', async() => {
    cloud.listReply = { status: 200, body: { requests: [request('req-a')] } };
    env.prompt = NOT_NOW;
    subject.startApprover();
    await until(() => env.timeline.includes('prompt'));
    await settle();
    subject.stopApprover();
    subject.startApprover();
    await until(() => env.timeline.filter(event => event === 'prompt').length === 2);
  });
});

// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// Characterization of the Desktop vault enrollment REQUESTER (this computer asks to join an existing
// Cloud vault). Pins the wire bytes Cloud verifies (sulla-workers cloud-vault-sync.ts) and the order of
// vault-broker calls, so moving the code onto @sulla/domain cannot change them. Synthetic data only.

import crypto from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DesktopEnrollmentHarness } from '../../Support/Vault/DesktopEnrollmentHarness';
import { FakeEnrollmentCloud, FakeVaultBroker, FixedDeviceKeyDir, type RecordedCloudCall } from '../../Support/Vault/EnrollmentFakes';
import { DesktopDeviceIdentity } from '../../../../main/cloud/device/DesktopDeviceIdentity';

const env = vi.hoisted(() => ({ cloud: null as any, broker: null as any, userId: 'user-0001', deviceDir: '' }));

vi.mock('@pkg/utils/paths', () => ({ default: { get sullaConfig() { return env.deviceDir } } }));
vi.mock('../../../../main/deviceIdentity', () => ({ getDesktopDeviceId: async() => 'device-0001', readExistingDesktopDeviceId: () => 'device-0001' }));
vi.mock('../../../../main/sullaCloudAuth', () => ({ getCurrentUserId: async() => env.userId }));
vi.mock('../../../../main/cloud/cloudFetch', () => ({ cloudRequest: (method: string, url: string, options: any) => env.cloud.request(method, url, options) }));
vi.mock('@pkg/vault-broker', () => ({ getConfiguredApprovalClient: () => env.broker }));
vi.mock('@pkg/sulla', () => ({ onVaultUnlocked: async() => { env.broker.events.push('unlocked') } }));
vi.mock('electron', () => ({ BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] }, dialog: { showMessageBox: async() => ({ response: 1 }) } }));

const VAULT = '11111111-2222-4333-8444-555555555555';
const T0 = 1_770_000_000_000;
const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const ENVELOPE = { format: 'sulla-files-sync-transport', v: 1, alg: 'ECDH-P256+HKDF-SHA256+A256GCM', epk: 'epk-1', nonce: 'nonce-1', ct: 'ct-1' };
const MASTER = new Uint8Array(32).fill(7);

let keyDir: FixedDeviceKeyDir;
let cloud: FakeEnrollmentCloud;
let broker: FakeVaultBroker;

const sha = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
const signedMessage = (op: string, bodyHash: string, ts: string, userId = 'user-0001') => ['sulla-vault-sync-v3', userId, 'device-0001', VAULT, op, bodyHash, ts].join('\n');

function expectSigned(call: RecordedCloudCall, op: string, userId = 'user-0001'): void {
  const ts = call.headers['X-Sulla-Timestamp'];
  expect(call.query.get('deviceId')).toBe('device-0001');
  expect(ts).toMatch(/^\d{10}$/); // risk: Cloud rejects a millisecond timestamp
  const message = signedMessage(op, call.body === undefined ? EMPTY_SHA : sha(call.body), ts, userId);
  expect(FixedDeviceKeyDir.verify(message, call.headers['X-Sulla-Device-Signature'])).toBe(true);
}

async function harness(): Promise<DesktopEnrollmentHarness> {
  vi.resetModules();
  return DesktopEnrollmentHarness.load();
}

/** Waits (in real time) until the code under test has armed its next sleep timer. */
async function untilTimerArmed(): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (vi.getTimerCount() === 0) {
    if (performance.now() > deadline) throw new Error('no poll timer was armed');
    await new Promise(resolve => setImmediate(resolve));
  }
}

/** Lets the poll loop run `attempts` 5 s sleeps. */
async function runPolls(attempts: number): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    await untilTimerArmed();
    await vi.advanceTimersByTimeAsync(5_000);
  }
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0, toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  keyDir = new FixedDeviceKeyDir();
  DesktopDeviceIdentity.useInstance(null); // the identity is process-wide; rebuild it over this test's dir
  env.deviceDir = keyDir.dir;
  env.userId = 'user-0001';
  env.cloud = cloud = new FakeEnrollmentCloud(VAULT);
  env.broker = broker = new FakeVaultBroker();
});

afterEach(() => {
  vi.useRealTimers();
  keyDir.remove();
});

describe('vault enrollment gate (requester)', () => {
  it('refuses without a Cloud session and makes no network call', async() => {
    env.userId = '';
    const subject = await harness();
    await expect(subject.gate()).rejects.toThrow('enrollment_requires_cloud_session');
    expect(cloud.calls).toHaveLength(0);
  });

  it('answers create when Cloud has no enabled vault, after one unsigned status lookup', async() => {
    cloud.status = { status: 200, body: { enabled: false } };
    const subject = await harness();
    await expect(subject.gate()).resolves.toBe('create');
    expect(cloud.calls.map(c => `${ c.method } ${ c.path }`)).toEqual(['GET /cloud-vault-sync/status']);
    expect(cloud.calls[0].query.get('deviceId')).toBe('device-0001');
  });

  it.each([
    ['no_vault', 'create'],
    ['trusted', 'trusted'],
    ['recovery_required', 'recovery'],
  ])('maps Cloud state %s to %s without opening a request', async(state, disposition) => {
    cloud.state = { status: 200, body: { state, vaultId: VAULT, epoch: 3 } };
    const subject = await harness();
    await expect(subject.gate()).resolves.toBe(disposition);
    expect(cloud.callsTo('/enrollment/requests', 'POST')).toHaveLength(0);
  });

  it('signs the state lookup with the known-answer vault-sync-v3 signature (seconds, empty-body hash)', async() => {
    // risk: Cloud rejects every enrollment if the signed bytes drift
    cloud.state = { status: 200, body: { state: 'trusted', vaultId: VAULT, epoch: 3 } };
    const subject = await harness();
    await subject.gate();
    const [call] = cloud.callsTo('/cloud-vault-sync/enrollment/state');
    expect(call.method).toBe('GET');
    expect(call.body).toBeUndefined();
    expect(call.headers['X-Sulla-Timestamp']).toBe('1770000000');
    expect(call.headers['X-Sulla-Device-Signature']).toBe('WRchWhF7272esCSp70CmnaSV6h1iMWabCwZi9BQe7s9jlc/G8QKR4KgfVLZaK6S9cVvtYUpbMBNF6rU//xtJAA==');
    expect(call.query.get('deviceId')).toBe('device-0001');
  });

  it.each(['approval_available', 'waiting_for_approver'])('passes %s through and opens the request early so an approver can see it', async(state) => {
    cloud.state = { status: 200, body: { state, vaultId: VAULT, epoch: 3 } };
    const subject = await harness();
    await expect(subject.gate()).resolves.toBe(state);
    const opens = cloud.callsTo(`/vaults/${ VAULT }/enrollment/requests`, 'POST');
    expect(opens).toHaveLength(1);
    const body = JSON.parse(opens[0].body!);
    expect(Object.keys(body)).toEqual(['publicKey', 'nonce']);
    expect(opens[0].body).toBe(JSON.stringify(body));
    expect(body.publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
    expect(Buffer.from(body.publicKey, 'base64url')[0]).toBe(4); // uncompressed P-256 point
    expect(body.nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(opens[0].headers['Content-Type']).toBe('application/json');
    expectSigned(opens[0], 'enrollment-request');
  });

  it('caches a successful lookup per user and looks up again for another user', async() => {
    cloud.state = { status: 200, body: { state: 'trusted', vaultId: VAULT, epoch: 3 } };
    const subject = await harness();
    await subject.gate();
    await subject.gate();
    expect(cloud.callsTo('/enrollment/state')).toHaveLength(1);
    env.userId = 'user-0002';
    await subject.gate();
    expect(cloud.callsTo('/enrollment/state')).toHaveLength(2);
  });

  it('never caches a failed lookup: the next call asks Cloud again', async() => {
    cloud.status = { status: 503, body: { error: 'unavailable' } };
    const subject = await harness();
    await expect(subject.gate()).rejects.toThrow();
    cloud.status = { status: 200, body: { enabled: false } };
    await expect(subject.gate()).resolves.toBe('create');
  });

  it('swallows a 409 when opening the request, but not other errors', async() => {
    cloud.openReplies.push({ status: 409, body: { error: 'request_already_pending' } });
    const subject = await harness();
    await expect(subject.gate()).resolves.toBe('waiting_for_approver');

    const other = await harness();
    cloud.openReplies.push({ status: 500, body: { error: 'boom' } });
    await expect(other.gate()).rejects.toThrow();
  });
});

describe('vault enrollment completion (requester)', () => {
  it('polls sleep-first, keeps polling on 409, then adopts in the broker, confirms, commits and unlocks in that order', async() => {
    cloud.consumeReplies.push({ status: 409, body: { error: 'request_not_found_or_consumed' } }, { status: 200, body: { wrappedUserKey: ENVELOPE } });
    const subject = await harness();
    const done = subject.complete(MASTER, 'user-0001');
    await untilTimerArmed();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(cloud.callsTo('/consume')).toHaveLength(0); // risk: polling before the first sleep
    await vi.advanceTimersByTimeAsync(1);
    await runPolls(1);
    await expect(done).resolves.toBe('adopted');

    const consumes = cloud.callsTo('/consume');
    expect(consumes).toHaveLength(2);
    expect(consumes[0].path).toBe(`/cloud-vault-sync/vaults/${ VAULT }/enrollment/requests/req-0001/consume`);
    expect(consumes[0].body).toBe('{}');
    expect(consumes[0].headers['X-Sulla-Timestamp']).toBe('1770000005');
    expect(consumes[0].headers['X-Sulla-Device-Signature']).toBe('Pmy2sY1ljaEYNjp66C24JdNhmoC40w5d19mUuWnig3GkxRWE+UTnBSJl+El+ryy9RHdezIWKYuwx+BQbp4D4Cg==');

    const [confirm] = cloud.callsTo('/confirm');
    expect(confirm.body).toBe('{"bundleMac":"bundle-mac","headMac":"head-mac"}');
    expectSigned(confirm, 'enrollment-confirm:req-0001');
    expect(broker.events).toEqual(['adopt', 'commit', 'unlocked']);
    expect(broker.commitCalls).toEqual(['req-0001']);
    const callOrder = cloud.calls.map(c => c.path.split('/').pop());
    expect(callOrder.indexOf('confirm')).toBeGreaterThan(callOrder.lastIndexOf('consume'));
  });

  it('hands the broker the request private key, envelope, master key and Cloud user, and never a user key', async() => {
    // risk: key custody — the vault user key must stay inside the vault container
    cloud.consumeReplies.push({ status: 200, body: { wrappedUserKey: ENVELOPE } });
    const subject = await harness();
    const done = subject.complete(MASTER, 'user-0001');
    await runPolls(1);
    await done;
    const [open] = cloud.callsTo(`/vaults/${ VAULT }/enrollment/requests`, 'POST');
    const publicKey = Buffer.from(JSON.parse(open.body!).publicKey, 'base64url');
    const [args] = broker.adoptCalls as any[];
    expect(Object.keys(args).sort()).toEqual(['cloudUserId', 'masterKey', 'privateKeyJwk', 'requestId', 'vaultEpoch', 'vaultId', 'wrappedUserKey']);
    expect(args).toMatchObject({ requestId: 'req-0001', vaultId: VAULT, vaultEpoch: 3, wrappedUserKey: ENVELOPE, masterKey: Buffer.from(MASTER).toString('base64url'), cloudUserId: 'user-0001' });
    expect(args.privateKeyJwk).toMatchObject({ kty: 'EC', crv: 'P-256' });
    expect(typeof args.privateKeyJwk.d).toBe('string');
    expect(Buffer.from(args.privateKeyJwk.x, 'base64url')).toEqual(publicKey.subarray(1, 33));
    expect(Buffer.from(args.privateKeyJwk.y, 'base64url')).toEqual(publicKey.subarray(33, 65));
  });

  it('signs consume and confirm as the Cloud user it was given', async() => {
    cloud.consumeReplies.push({ status: 200, body: { wrappedUserKey: ENVELOPE } });
    const subject = await harness();
    const done = subject.complete(MASTER, 'user-cloud');
    await runPolls(1);
    await done;
    expectSigned(cloud.callsTo('/consume')[0], 'enrollment-consume:req-0001', 'user-cloud');
    expectSigned(cloud.callsTo('/confirm')[0], 'enrollment-confirm:req-0001', 'user-cloud');
  });

  it('keeps polling on a 409 whatever its error code', async() => {
    cloud.consumeReplies.push({ status: 409, body: { error: 'confirmation_conflict' } }, { status: 409 }, { status: 200, body: { wrappedUserKey: ENVELOPE } });
    const subject = await harness();
    const done = subject.complete(MASTER, 'user-0001');
    await runPolls(3);
    await expect(done).resolves.toBe('adopted');
    expect(cloud.callsTo('/consume')).toHaveLength(3);
  });

  it('stops on a non-409 consume error without touching the broker', async() => {
    cloud.consumeReplies.push({ status: 500, body: { error: 'boom' } });
    const subject = await harness();
    const done = subject.complete(MASTER, 'user-0001');
    const settled = expect(done).rejects.toThrow();
    await runPolls(1);
    await settled;
    expect(broker.events).toEqual([]);
  });

  it('stops at once with enrollment_denied when an approver denied the request (410)', async() => {
    // risk: auth/UX — a denied device must stop asking instead of polling until the request expires
    cloud.consumeReplies.push({ status: 409, body: { error: 'request_not_found_or_consumed' } }, { status: 410, body: { error: 'request_denied' } });
    const subject = await harness();
    const done = subject.complete(MASTER, 'user-0001');
    const settled = expect(done).rejects.toThrow('enrollment_denied');
    await runPolls(2);
    await settled;
    expect(cloud.callsTo('/consume')).toHaveLength(2);
    expect(broker.events).toEqual([]);
  });

  it('gives up with enrollment_timeout after exactly 60 polls', async() => {
    const subject = await harness();
    const done = subject.complete(MASTER, 'user-0001');
    const settled = expect(done).rejects.toThrow('enrollment_timeout');
    await runPolls(60);
    await settled;
    expect(cloud.callsTo('/consume')).toHaveLength(60);
    expect(broker.events).toEqual([]);
  });

  it('does not commit when Cloud rejects the confirmation', async() => {
    cloud.consumeReplies.push({ status: 200, body: { wrappedUserKey: ENVELOPE } });
    cloud.confirmReply = { status: 403, body: { error: 'invalid_proof' } };
    const subject = await harness();
    const done = subject.complete(MASTER, 'user-0001');
    const settled = expect(done).rejects.toThrow();
    await runPolls(1);
    await settled;
    expect(broker.events).toEqual(['adopt']);
  });

  it('runs one enrollment for concurrent callers (single flight)', async() => {
    cloud.consumeReplies.push({ status: 409 }, { status: 200, body: { wrappedUserKey: ENVELOPE } });
    const subject = await harness();
    const first = subject.complete(MASTER, 'user-0001');
    const second = subject.complete(MASTER, 'user-0001');
    await runPolls(2);
    await expect(Promise.all([first, second])).resolves.toEqual(['adopted', 'adopted']);
    expect(cloud.callsTo(`/vaults/${ VAULT }/enrollment/requests`, 'POST')).toHaveLength(1);
    expect(cloud.callsTo('/consume')).toHaveLength(2);
    expect(broker.events).toEqual(['adopt', 'commit', 'unlocked']);
  });

  it('reuses the request opened at gate time instead of opening a second one', async() => {
    cloud.consumeReplies.push({ status: 200, body: { wrappedUserKey: ENVELOPE } });
    const subject = await harness();
    await subject.gate();
    const done = subject.complete(MASTER, 'user-0001');
    await runPolls(1);
    await done;
    expect(cloud.callsTo(`/vaults/${ VAULT }/enrollment/requests`, 'POST')).toHaveLength(1);
  });

  it('returns the waiting disposition without polling when the request cannot be opened (409 twice)', async() => {
    cloud.openReplies.push({ status: 409, body: { error: 'request_already_pending' } }, { status: 409, body: { error: 'request_already_pending' } });
    const subject = await harness();
    await expect(subject.complete(MASTER, 'user-0001')).resolves.toBe('waiting_for_approver');
    expect(cloud.callsTo(`/vaults/${ VAULT }/enrollment/requests`, 'POST')).toHaveLength(2);
    expect(cloud.callsTo('/consume')).toHaveLength(0);
  });

  it('returns trusted without enrolling when Cloud already trusts this device', async() => {
    cloud.state = { status: 200, body: { state: 'trusted', vaultId: VAULT, epoch: 3 } };
    const subject = await harness();
    await expect(subject.complete(MASTER, 'user-0001')).resolves.toBe('trusted');
    expect(broker.events).toEqual([]);
  });
});

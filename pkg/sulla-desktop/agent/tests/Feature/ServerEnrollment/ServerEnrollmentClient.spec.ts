// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * M6 D1: the Sulla Server device-proof enrollment client. The real domain `DeviceIdentityService` (real node:crypto
 * Ed25519 via Desktop's `NodeDeviceCrypto`, in-memory stores seeded from the vectors) signs through the real client
 * classes; only the HTTP transport is a recording fake. `fixtures/device-proof-vectors.json` is copied from sulla-server
 * PR #14 (see its `source` key): reproducing those bytes is what makes Desktop wire-compatible with the server.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { DeviceIdentityService } from '@sulla/domain';

import { NodeDeviceCrypto } from '../../../../main/cloud/device/NodeDeviceCrypto';
import { ServerDeviceMessage } from '../../../../main/serverEnrollment/ServerDeviceMessage';
import { ServerDeviceSigner, type NonceSource } from '../../../../main/serverEnrollment/ServerDeviceSigner';
import { ServerEnrollmentClient, ServerEnrollmentError, type FetchLike } from '../../../../main/serverEnrollment/ServerEnrollmentClient';

const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'device-proof-vectors.json'), 'utf8'));
const DESKTOP_API = 'https://server.example.test/desktop/v1';

/** A clock the test moves by hand (the sleeper advances it). */
class ManualClock {
  constructor(private ms: number) {}

  now(): Date { return new Date(this.ms) }

  advance(ms: number): void { this.ms += ms }
}

class MemoryStore<T> {
  constructor(private value: T | null) {}

  async read(): Promise<T | null> { return this.value }

  async createIfAbsent(value: T): Promise<boolean> {
    if (this.value !== null) return false;
    this.value = value;

    return true;
  }
}

/** The nonce bytes behind the vector nonce `AAECAwQFBgcICQoLDA0ODw` (0x00..0x0f), or fresh random bytes. */
class FixedNonceSource implements NonceSource {
  constructor(private readonly fixed: boolean) {}

  bytes(length: number): Uint8Array {
    return this.fixed ? Uint8Array.from({ length }, (_, index) => index) : new Uint8Array(crypto.randomBytes(length));
  }
}

interface RecordedCall { url: string; method: string; headers: Record<string, string>; body?: string }

/** A recording HTTP transport that answers from a queue of `[status, json]` replies. */
class FakeServer {
  readonly calls: RecordedCall[] = [];
  private readonly replies: Array<[number, unknown]> = [];

  reply(status: number, json?: unknown): this {
    this.replies.push([status, json]);

    return this;
  }

  readonly fetch: FetchLike = async(url, init) => {
    this.calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const [status, json] = this.replies.shift() ?? [500, { error: 'no reply queued' }];

    return { status, text: async() => (json === undefined ? '' : JSON.stringify(json)) };
  };
}

/** One Desktop: the vector device's identity, a fake clock at the vector second, and the client under test. */
class VectorDesktop {
  readonly clock = new ManualClock(vectors.enrollment.ts * 1000);
  readonly server = new FakeServer();
  readonly sleeps: number[] = [];
  readonly identity: DeviceIdentityService;
  readonly client: ServerEnrollmentClient;

  constructor(options: { fixedNonce?: boolean; seedHex?: string } = {}) {
    this.identity = new DeviceIdentityService(
      new MemoryStore<string>(vectors.device.deviceId),
      new MemoryStore<Uint8Array>(new Uint8Array(Buffer.from(options.seedHex ?? vectors.device.seedHex, 'hex'))),
      new NodeDeviceCrypto(),
      { bytes: () => { throw new Error('the vector identity never generates') } },
      this.clock,
    );
    const sleep = async(ms: number) => {
      this.sleeps.push(ms);
      this.clock.advance(ms);
    };
    const signer = new ServerDeviceSigner(vectors.server.serverId, this.identity, this.clock, new FixedNonceSource(options.fixedNonce ?? true), sleep);
    this.client = new ServerEnrollmentClient(DESKTOP_API, signer, this.server.fetch, sleep);
  }
}

/** Independent Ed25519 check with node:crypto over a raw 32-byte base64 public key. */
function verifies(publicKeyB64: string, message: string, signatureB64: string): boolean {
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKeyB64, 'base64')]);

  return crypto.verify(null, Buffer.from(message, 'utf8'), crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' }), Buffer.from(signatureB64, 'base64'));
}

function requestMessage(call: RecordedCall, method: string): string {
  return [
    'sulla-server-device-v1', 'request', vectors.server.serverId, vectors.device.deviceId, method, new URL(call.url).pathname,
    call.headers['x-sulla-device-ts'], call.headers['x-sulla-device-nonce'], crypto.createHash('sha256').update(call.body ?? '').digest('hex'),
  ].join('\n');
}

describe('ServerEnrollmentClient: shared device-proof vectors', () => {
  // risk: auth — any byte drift and every Desktop is refused by the server.
  it('derives the vector public keys from the vector seeds', async() => {
    expect(await new VectorDesktop().identity.publicKey()).toBe(vectors.device.publicKey);
    expect(await new VectorDesktop({ seedHex: vectors.nextDevice.seedHex }).identity.publicKey()).toBe(vectors.nextDevice.publicKey);
  });

  // risk: auth — the enrollment proof must be byte-identical to the server's expected message and signature.
  it('enrolls with exactly the vector enrollment body and proof', async() => {
    const desktop = new VectorDesktop();
    desktop.server.reply(202, { enrollment: { id: 'e5a0c3c1-0000-4000-8000-000000000001', status: 'pending', expires_at: '2026-11-13T00:00:00.000Z' }, pollToken: 'poll-token' });

    const submitted = await desktop.client.enroll('enrollment-bearer', vectors.server.organizationId);

    const [call] = desktop.server.calls;
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`${ DESKTOP_API }/enrollments`);
    expect(call.headers.authorization).toBe('Bearer enrollment-bearer');
    expect(call.body).toBe(JSON.stringify(vectors.enrollment.body));
    expect(ServerDeviceMessage.enrollment({
      serverId: vectors.server.serverId, organizationId: vectors.server.organizationId, deviceId: vectors.device.deviceId, publicKey: vectors.device.publicKey, ts: vectors.enrollment.ts,
    }).toString()).toBe(vectors.enrollment.message);
    expect(submitted).toEqual({ enrollmentId: 'e5a0c3c1-0000-4000-8000-000000000001', status: 'pending', expiresAt: '2026-11-13T00:00:00.000Z', pollToken: 'poll-token' });
  });

  // risk: auth — signed device request headers must equal the vector headers for the vector request.
  it('signs the vector token request with exactly the vector headers and raw body', async() => {
    const desktop = new VectorDesktop();
    desktop.server.reply(200, { token: 'jwt', expiresIn: 300, audience: 'sulla-vault' });

    const token = await desktop.client.audienceToken(vectors.server.serverDeviceRowId, 'sulla-vault');

    const [call] = desktop.server.calls;
    expect(call.method).toBe(vectors.request.method);
    expect(new URL(call.url).pathname).toBe(vectors.request.path);
    expect(call.body).toBe(vectors.request.rawBody);
    expect(ServerDeviceMessage.bodyDigest(call.body)).toBe(vectors.request.bodySha256);
    expect(requestMessage(call, 'POST')).toBe(vectors.request.message);
    expect({
      'x-sulla-device-ts':        call.headers['x-sulla-device-ts'],
      'x-sulla-device-nonce':     call.headers['x-sulla-device-nonce'],
      'x-sulla-device-signature': call.headers['x-sulla-device-signature'],
    }).toEqual(vectors.request.headers);
    expect(call.headers['content-type']).toBe('application/json');
    expect(token).toEqual({ token: 'jwt', expiresIn: 300, audience: 'sulla-vault' });
  });

  // risk: auth — key rotation must carry the current key's vector rotation proof for the next key.
  it('rotates the key with exactly the vector rotation body, signed by the current key', async() => {
    const desktop = new VectorDesktop();
    desktop.server.reply(200, { device: { id: vectors.server.serverDeviceRowId, publicKey: vectors.nextDevice.publicKey } });

    const rotated = await desktop.client.rotateKey(vectors.server.serverDeviceRowId, vectors.server.userId, vectors.nextDevice.publicKey);

    const [call] = desktop.server.calls;
    expect(new URL(call.url).pathname).toBe(`/desktop/v1/devices/${ vectors.server.serverDeviceRowId }/key`);
    expect(call.body).toBe(JSON.stringify(vectors.keyRotation.body));
    expect(verifies(vectors.device.publicKey, vectors.keyRotation.message, vectors.keyRotation.proof.signature)).toBe(true);
    expect(verifies(vectors.device.publicKey, requestMessage(call, 'POST'), call.headers['x-sulla-device-signature'])).toBe(true);
    expect(rotated).toEqual({ publicKey: vectors.nextDevice.publicKey });
  });
});

describe('ServerEnrollmentClient: signed requests', () => {
  // risk: auth — every signed call verifies under the device public key with its own method, path and body.
  it('signs heartbeat, relay ticket and delete so they verify with the vector public key', async() => {
    const desktop = new VectorDesktop({ fixedNonce: false });
    const rowId = vectors.server.serverDeviceRowId;
    desktop.server.reply(200, { ok: true, serverTime: '2026-11-13T00:00:00.000Z' }).reply(200, { token: 'ticket', expiresAt: '2026-11-13T00:01:00.000Z' }).reply(204);

    await desktop.client.heartbeat(rowId, { appVersion: '1.0.0' });
    await desktop.client.relayTicket(rowId);
    await desktop.client.remove(rowId);

    const [heartbeat, ticket, removal] = desktop.server.calls;
    expect(new URL(heartbeat.url).pathname).toBe(`/desktop/v1/devices/${ rowId }/heartbeat`);
    expect(new URL(ticket.url).pathname).toBe(`/desktop/v1/devices/${ rowId }/tickets/relay`);
    expect(removal.method).toBe('DELETE');
    expect(removal.body).toBeUndefined();
    for (const [call, method] of [[heartbeat, 'POST'], [ticket, 'POST'], [removal, 'DELETE']] as const) {
      expect(verifies(vectors.device.publicKey, requestMessage(call, method), call.headers['x-sulla-device-signature'])).toBe(true);
      expect(call.headers['x-sulla-device-nonce']).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    }
    // Two calls in the same second still sign different bytes (fresh nonce), so neither looks like a replay.
    expect(heartbeat.headers['x-sulla-device-nonce']).not.toBe(ticket.headers['x-sulla-device-nonce']);
  });

  // risk: auth — the signature binds the exact raw body bytes, method and path; a tampered request must not verify.
  it('covers the raw body: changing one body byte, the method or the path breaks the signature', async() => {
    const desktop = new VectorDesktop();
    desktop.server.reply(200, { token: 'jwt', expiresIn: 300, audience: 'sulla-vault' });
    await desktop.client.audienceToken(vectors.server.serverDeviceRowId, 'sulla-vault');
    const [call] = desktop.server.calls;
    const signature = call.headers['x-sulla-device-signature'];

    expect(verifies(vectors.device.publicKey, requestMessage(call, 'POST'), signature)).toBe(true);
    expect(verifies(vectors.device.publicKey, requestMessage({ ...call, body: '{"audience":"sulla-vauls"}' }, 'POST'), signature)).toBe(false);
    expect(verifies(vectors.device.publicKey, requestMessage({ ...call, body: '{ "audience":"sulla-vault"}' }, 'POST'), signature)).toBe(false);
    expect(verifies(vectors.device.publicKey, requestMessage(call, 'PUT'), signature)).toBe(false);
    expect(verifies(vectors.device.publicKey, requestMessage({ ...call, url: call.url.replace('/token', '/key') }, 'POST'), signature)).toBe(false);
  });

  // risk: auth — a newline in a signed field would let one signature stand for a different field list.
  it('refuses a newline in a signed field and sends nothing', async() => {
    const desktop = new VectorDesktop();

    await expect(desktop.client.enroll('bearer', `${ vectors.server.organizationId }\nother`)).rejects.toThrow(/newlines/);
    await expect(desktop.client.heartbeat('row\nid')).rejects.toThrow(/invalid/);
    expect(desktop.server.calls).toHaveLength(0);
  });
});

describe('ServerEnrollmentClient: enrollment flow', () => {
  // risk: duplicate submit — the server refuses an identical proof in the same second as a replay.
  it('waits for the next second before re-submitting an enrollment', async() => {
    const desktop = new VectorDesktop();
    const accepted = { enrollment: { id: 'e5a0c3c1-0000-4000-8000-000000000001', status: 'pending', expires_at: '2026-11-13T00:00:00.000Z' }, pollToken: 'p' };
    desktop.server.reply(202, accepted).reply(202, accepted);
    desktop.clock.advance(400);

    await desktop.client.enroll('bearer', vectors.server.organizationId);
    await desktop.client.enroll('bearer', vectors.server.organizationId);

    const [first, second] = desktop.server.calls.map(call => JSON.parse(call.body as string).proof);
    expect(first.ts).toBe(vectors.enrollment.ts);
    expect(second.ts).toBe(vectors.enrollment.ts + 1);
    expect(second.signature).not.toBe(first.signature);
    expect(desktop.sleeps).toEqual([600]);
    const message = (ts: number) => ServerDeviceMessage.enrollment({ serverId: vectors.server.serverId, organizationId: vectors.server.organizationId, deviceId: vectors.device.deviceId, publicKey: vectors.device.publicKey, ts }).toString();
    expect(verifies(vectors.device.publicKey, message(second.ts), second.signature)).toBe(true);
  });

  // risk: core flow — polling returns the server device id only once approved, with the poll token as bearer.
  it('polls until the enrollment is approved and returns the server device id', async() => {
    const desktop = new VectorDesktop();
    const id = 'e5a0c3c1-0000-4000-8000-000000000001';
    desktop.server
      .reply(200, { id, status: 'pending', expiresAt: '2026-11-13T00:00:00.000Z' })
      .reply(200, { id, status: 'pending', expiresAt: '2026-11-13T00:00:00.000Z' })
      .reply(200, { id, status: 'approved', expiresAt: '2026-11-13T00:00:00.000Z', device: { id: vectors.server.serverDeviceRowId } });

    const state = await desktop.client.waitForDecision(id, 'poll-token', 10, 2000);

    expect(state).toEqual({ enrollmentId: id, status: 'approved', expiresAt: '2026-11-13T00:00:00.000Z', serverDeviceId: vectors.server.serverDeviceRowId });
    expect(desktop.server.calls).toHaveLength(3);
    expect(desktop.server.calls.every(call => call.method === 'GET' && call.headers.authorization === 'Bearer poll-token' && call.body === undefined)).toBe(true);
    expect(desktop.sleeps).toEqual([2000, 2000]);
  });

  // risk: core flow — a denied enrollment stops polling at once and never yields a device id.
  it('stops polling on denial, and gives up after maxAttempts while still pending', async() => {
    const id = 'e5a0c3c1-0000-4000-8000-000000000001';
    const denied = new VectorDesktop();
    denied.server.reply(200, { id, status: 'denied', expiresAt: '2026-11-13T00:00:00.000Z' });
    expect(await denied.client.waitForDecision(id, 'p', 10, 1)).toMatchObject({ status: 'denied', serverDeviceId: null });
    expect(denied.server.calls).toHaveLength(1);

    const pending = new VectorDesktop();
    for (let i = 0; i < 3; i++) pending.server.reply(200, { id, status: 'pending', expiresAt: '2026-11-13T00:00:00.000Z' });
    expect(await pending.client.waitForDecision(id, 'p', 3, 1)).toMatchObject({ status: 'pending', serverDeviceId: null });
    expect(pending.server.calls).toHaveLength(3);
  });

  // risk: error handling — server refusals surface their status and code; malformed answers never pass as success.
  it('surfaces server error codes and rejects malformed success answers', async() => {
    const desktop = new VectorDesktop();
    desktop.server.reply(409, { error: 'device_id_in_use' }).reply(401, { error: 'stale_device_proof' }).reply(200, { enrollment: { id: 'x' } }).reply(502);

    await expect(desktop.client.enroll('b', vectors.server.organizationId)).rejects.toMatchObject({ status: 409, code: 'device_id_in_use' });
    await expect(desktop.client.heartbeat(vectors.server.serverDeviceRowId)).rejects.toMatchObject({ status: 401, code: 'stale_device_proof' });
    desktop.clock.advance(1000);
    await expect(desktop.client.enroll('b', vectors.server.organizationId)).rejects.toMatchObject({ status: 502, code: 'malformed_response' });
    const failure = await desktop.client.relayTicket(vectors.server.serverDeviceRowId).catch(error => error);
    expect(failure).toBeInstanceOf(ServerEnrollmentError);
    expect(failure).toMatchObject({ status: 502, code: 'http_error' });
  });
});

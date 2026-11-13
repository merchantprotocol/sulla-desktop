// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * F1: Desktop proves a Cloud sign-in or refresh came from THIS device, so Cloud (W-ID-6) can bind the session to it.
 * Headers X-Sulla-Device-Id, X-Sulla-Timestamp (unix s) and X-Sulla-Device-Signature = base64 Ed25519 over
 * "sulla-session-bind-v1\n<deviceId>\n<ts>\n<path, no query>\n<sha256 hex of the exact body bytes sent>".
 *
 * Real classes throughout: the domain DeviceIdentityService over the Desktop file stores in a temp dir, real node:crypto
 * Ed25519, the real transport and HTTP client. Only fetch is replaced by a recording fake Cloud.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DeviceIdentityService } from '@sulla/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ElectronCloudAccountTransport } from '../../../../main/cloud/account/ElectronCloudAccountTransport';
import { SullaCloudHttpClient } from '../../../../main/cloud/account/SullaCloudHttpClient';
import { FileDeviceIdStore } from '../../../../main/cloud/device/FileDeviceIdStore';
import { FileDeviceKeyStore } from '../../../../main/cloud/device/FileDeviceKeyStore';
import { NodeDeviceCrypto, NodeRandomSource } from '../../../../main/cloud/device/NodeDeviceCrypto';
import { SessionBindProof } from '../../../../main/cloud/device/SessionBindProof';
import { SessionBindSigner } from '../../../../main/cloud/device/SessionBindSigner';

const NOW = new Date('2026-11-12T18:00:00.000Z');
const NOW_S = Math.floor(NOW.getTime() / 1000);
const clock = { now: () => NOW };

/** Cloud's side (sulla-workers epic/cloud-auth-oop DeviceSessionProof + verifyEd25519), rebuilt from the published framing. */
class CloudSideVerifier {
  static message(deviceId: string, ts: number | string, requestPath: string, rawBody: string): string {
    return ['sulla-session-bind-v1', deviceId, String(ts), requestPath, crypto.createHash('sha256').update(rawBody).digest('hex')].join('\n');
  }

  /** What DeviceSessionBinder does with an enrolled raw 32-byte base64 public key. */
  static verify(publicKeyB64: string, message: string, signatureB64: string): boolean {
    const key = crypto.createPublicKey({
      key:    Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKeyB64, 'base64')]),
      format: 'der',
      type:   'spki',
    });

    return crypto.verify(null, Buffer.from(message, 'utf8'), key, Buffer.from(signatureB64, 'base64'));
  }
}

interface SeenRequest { path: string; rawBody: string; headers: Record<string, string> }

/** A Sulla Cloud that records each request's raw body and headers exactly as fetch received them. */
class RecordingCloud {
  readonly requests: SeenRequest[] = [];
  private readonly replies: Array<Response | 'network'> = [];

  readonly http = new SullaCloudHttpClient(async(url, init) => {
    this.requests.push({ path: url.replace('https://cloud.test', ''), rawBody: String(init.body ?? ''), headers: { ...(init.headers as Record<string, string>) } });
    const reply = this.replies.shift();
    if (reply === 'network') throw new TypeError('fetch failed');
    return reply ?? new Response(JSON.stringify({ accessToken: 'at-1', refreshToken: 'rt-1', contractor: { id: 'c-1' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }, 'https://cloud.test', 20_000, 0);

  reply(...replies: Array<Response | 'network'>): void {
    this.replies.push(...replies);
  }
}

describe('SessionBindProof framing (risk: session hijack / replay)', () => {
  let dir: string;
  let identity: DeviceIdentityService;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f1-session-bind-'));
    identity = new DeviceIdentityService(FileDeviceIdStore.in(() => dir), FileDeviceKeyStore.in(() => dir, clock), new NodeDeviceCrypto(), new NodeRandomSource(), clock);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('risk: session binding. the signature verifies with the device public key over the exact framed bytes', async() => {
    const body = JSON.stringify({ email: 'owner@example.test', authHash: 'h-1' });
    const headers = await new SessionBindSigner(async() => identity, clock, () => {}).headersFor('/auth/email/login', body);
    const deviceId = (await identity.deviceId()).value;

    expect(headers['X-Sulla-Device-Id']).toBe(deviceId);
    expect(headers['X-Sulla-Timestamp']).toBe(String(NOW_S));
    expect(CloudSideVerifier.verify(await identity.publicKey(), CloudSideVerifier.message(deviceId, NOW_S, '/auth/email/login', body), headers['X-Sulla-Device-Signature'])).toBe(true);
  });

  it('risk: replay. changing the path, body, timestamp or device id breaks verification', async() => {
    const body = JSON.stringify({ refreshToken: 'rt-1' });
    const headers = await new SessionBindSigner(async() => identity, clock, () => {}).headersFor('/auth/refresh', body);
    const deviceId = (await identity.deviceId()).value;
    const publicKey = await identity.publicKey();
    const signature = headers['X-Sulla-Device-Signature'];
    const verifies = (id: string, ts: number, p: string, b: string) => CloudSideVerifier.verify(publicKey, CloudSideVerifier.message(id, ts, p, b), signature);

    expect(verifies(deviceId, NOW_S, '/auth/refresh', body)).toBe(true);
    expect(verifies(deviceId, NOW_S, '/auth/email/login', body)).toBe(false);
    expect(verifies(deviceId, NOW_S, '/auth/refresh', JSON.stringify({ refreshToken: 'rt-2' }))).toBe(false);
    expect(verifies(deviceId, NOW_S, '/auth/refresh', `${ body } `)).toBe(false);
    expect(verifies(deviceId, NOW_S + 1, '/auth/refresh', body)).toBe(false);
    expect(verifies(`${ deviceId }x`, NOW_S, '/auth/refresh', body)).toBe(false);
  });

  it('risk: binding refused. the query string is not part of the signed path (Cloud signs c.req.path)', () => {
    const withQuery = SessionBindProof.frame('dev-1', NOW_S, '/auth/refresh?attempt=2#x', '{}');

    expect(withQuery.message()).toBe(CloudSideVerifier.message('dev-1', NOW_S, '/auth/refresh', '{}'));
  });

  it('risk: header injection. a device id or path that would add a line to the signed message is refused', () => {
    expect(() => SessionBindProof.frame('dev\n1', NOW_S, '/auth/refresh', '{}')).toThrow();
    expect(() => SessionBindProof.frame('dev-1', NOW_S, '/auth/re\nfresh', '{}')).toThrow();
    expect(() => SessionBindProof.frame('dev-1', NOW_S, 'auth/refresh', '{}')).toThrow();
    expect(() => SessionBindProof.frame('dev-1', 1.5, '/auth/refresh', '{}')).toThrow();
  });

  it('risk: cross-implementation drift. matches a vector built with the Workers verifier framing', () => {
    // Fixed RFC 8032 test key 1 seed; the expected message is what workers DeviceSessionProof.message() produces.
    const seed = Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex');
    const body = '{"email":"owner@example.test","authHash":"h-1"}';
    const proof = SessionBindProof.frame('wid6-owner-desktop', 1794525600, '/auth/email/login', body);
    const expected = 'sulla-session-bind-v1\nwid6-owner-desktop\n1794525600\n/auth/email/login\n'
      + crypto.createHash('sha256').update(body).digest('hex');
    const nodeCrypto = new NodeDeviceCrypto();
    const signature = Buffer.from(nodeCrypto.ed25519Sign(seed, proof.bytes())).toString('base64');

    expect(proof.message()).toBe(expected);
    expect(CloudSideVerifier.verify(Buffer.from(nodeCrypto.ed25519PublicKey(seed)).toString('base64'), expected, signature)).toBe(true);
    expect(proof.headers(signature)).toEqual({ 'X-Sulla-Device-Id': 'wid6-owner-desktop', 'X-Sulla-Timestamp': '1794525600', 'X-Sulla-Device-Signature': signature });
  });

  it('risk: lost sign-in. an unavailable identity yields no headers and a warning without secrets', async() => {
    const warnings: string[] = [];
    const broken = new SessionBindSigner(async() => { throw new Error('device key file is corrupt') }, clock, m => warnings.push(m));

    expect(await broken.headersFor('/auth/email/login', '{"authHash":"secret-hash"}')).toEqual({});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain('secret-hash');
  });

  it('risk: lost sign-in. an identity that never answers does not hold sign-in past the timeout', async() => {
    const stuck = new SessionBindSigner(() => new Promise(() => {}), clock, () => {}, 20);

    expect(await stuck.headersFor('/auth/refresh', '{}')).toEqual({});
  });
});

describe('ElectronCloudAccountTransport sends the session-bind proof (risk: session binding)', () => {
  let dir: string;
  let identity: DeviceIdentityService;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f1-transport-'));
    identity = new DeviceIdentityService(FileDeviceIdStore.in(() => dir), FileDeviceKeyStore.in(() => dir, clock), new NodeDeviceCrypto(), new NodeRandomSource(), clock);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const transportOver = (cloud: RecordingCloud, signer: SessionBindSigner) => new ElectronCloudAccountTransport({ http: cloud.http, sessionBind: signer });

  const assertSigned = async(request: SeenRequest, expectedPath: string) => {
    const deviceId = (await identity.deviceId()).value;
    expect(request.path).toBe(expectedPath);
    expect(request.headers['Content-Type']).toBe('application/json');
    expect(request.headers['X-Sulla-Device-Id']).toBe(deviceId);
    expect(request.headers['X-Sulla-Timestamp']).toBe(String(NOW_S));
    expect(CloudSideVerifier.verify(
      await identity.publicKey(),
      CloudSideVerifier.message(deviceId, NOW_S, expectedPath, request.rawBody),
      request.headers['X-Sulla-Device-Signature'],
    )).toBe(true);
  };

  it('email login is signed over the exact body bytes it sent', async() => {
    const cloud = new RecordingCloud();
    await transportOver(cloud, new SessionBindSigner(async() => identity, clock, () => {})).emailLogin({ email: 'owner@example.test', authHash: 'h-1' });

    expect(cloud.requests).toHaveLength(1);
    await assertSigned(cloud.requests[0], '/auth/email/login');
  });

  it('refresh is signed, including the retried attempt and the first-run single-attempt transport', async() => {
    const cloud = new RecordingCloud();
    cloud.reply('network', new Response(JSON.stringify({ accessToken: 'at-2' }), { status: 200 }));
    const transport = transportOver(cloud, new SessionBindSigner(async() => identity, clock, () => {}));

    await transport.refresh({ refreshToken: 'rt-1' });
    await transport.withSingleAttemptRefresh().refresh({ refreshToken: 'rt-2' });

    expect(cloud.requests).toHaveLength(3);
    for (const request of cloud.requests) await assertSigned(request, '/auth/refresh');
  });

  it('every session-creating sign-in is signed; prelogin, code sends and logout are not', async() => {
    const cloud = new RecordingCloud();
    const transport = transportOver(cloud, new SessionBindSigner(async() => identity, clock, () => {}));
    cloud.reply(new Response(JSON.stringify({ kdf: {}, authVersion: 2 }), { status: 200 }));

    await transport.prelogin({ email: 'o@example.test' });
    await transport.register({ email: 'o@example.test', authHash: 'h', kdf: {} as never, timezone: 'UTC' });
    await transport.upgrade({ email: 'o@example.test', password: 'p', authHash: 'h', kdf: {} as never });
    await transport.startEmailCode({ email: 'o@example.test' });
    await transport.verifyEmailCode({ email: 'o@example.test', code: '111111' });
    await transport.phoneOtpSend({ phone: '+15551234567' });
    await transport.phoneOtpVerify({ phone: '+15551234567', code: '123456' });
    await transport.apple({ identityToken: 'apple-jwt' });
    await transport.handoffRedeem({ code: 'h'.repeat(43) });
    await transport.logout({ refreshToken: 'rt-1' });

    const signed = cloud.requests.filter(r => 'X-Sulla-Device-Signature' in r.headers).map(r => r.path);
    expect(signed).toEqual(['/auth/email/register', '/auth/upgrade', '/auth/email-code/verify', '/auth/otp/verify', '/auth/apple', '/auth/handoff/redeem']);
    for (const request of cloud.requests.filter(r => signed.includes(r.path))) await assertSigned(request, request.path);
  });

  it('risk: lost sign-in. a missing identity sends login and refresh without proof headers and still signs in', async() => {
    const cloud = new RecordingCloud();
    const transport = transportOver(cloud, new SessionBindSigner(async() => { throw new Error('no device identity yet') }, clock, () => {}));

    const session = await transport.emailLogin({ email: 'owner@example.test', authHash: 'h-1' });
    const pair = await transport.refresh({ refreshToken: 'rt-1' });

    expect(session.accessToken).toBe('at-1');
    expect(pair.accessToken).toBe('at-1');
    expect(cloud.requests.map(r => Object.keys(r.headers))).toEqual([['Content-Type'], ['Content-Type']]);
    expect(cloud.requests[0].rawBody).toBe(JSON.stringify({ email: 'owner@example.test', authHash: 'h-1' }));
  });

  it('a transport built without a signer sends no proof headers (unchanged wire format)', async() => {
    const cloud = new RecordingCloud();
    await new ElectronCloudAccountTransport({ http: cloud.http }).emailLogin({ email: 'owner@example.test', authHash: 'h-1' });

    expect(Object.keys(cloud.requests[0].headers)).toEqual(['Content-Type']);
  });
});

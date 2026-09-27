/** @jest-environment node */
import crypto from 'crypto';

import {
  checkPairRequest, clientIdFromPublicKey, NonceCache, pairingCode, verifySignedFrame, type ApprovedClient,
} from '../secureChannelProtocol';

function makeClient() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const pub = Buffer.from((publicKey.export({ format: 'jwk' }) as any).x, 'base64url').toString('base64');
  return { privateKey, pub, clientId: clientIdFromPublicKey(pub) };
}

function signedFrame(c: ReturnType<typeof makeClient>, payload: Record<string, unknown>, from: Record<string, unknown> = {}) {
  const signed = JSON.stringify(payload);
  const sig = crypto.sign(null, Buffer.from(signed), c.privateKey).toString('base64');
  return { type: 'client_frame', kind: 'signed', from: { userId: 'owner', clientId: c.clientId, surface: 'web', ...from }, signed, sig } as any;
}

const NOW = 1_800_000_000_000;

function ctxFor(approved: ApprovedClient[], nonces = new NonceCache()) {
  return { ownUserId: 'owner', deviceId: 'device-1', approved: (id: string) => approved.find(a => a.clientId === id), nonces, now: NOW };
}

function approvedEntry(c: ReturnType<typeof makeClient>): ApprovedClient {
  return { clientId: c.clientId, publicKey: c.pub, label: 'Chrome', surface: 'web', approvedAt: 'x' };
}

function goodPayload(c: ReturnType<typeof makeClient>, overrides: Record<string, unknown> = {}) {
  return { v: 1, deviceId: 'device-1', clientId: c.clientId, ts: NOW, nonce: crypto.randomBytes(16).toString('base64'), body: { type: 'chat', conversationId: 'conv-1' }, ...overrides };
}

describe('verifySignedFrame', () => {
  test('accepts a correctly signed command from an approved client', () => {
    const c = makeClient();
    const res = verifySignedFrame(signedFrame(c, goodPayload(c)), ctxFor([approvedEntry(c)]));
    expect(res).toEqual({ ok: true, command: { clientId: c.clientId, body: { type: 'chat', conversationId: 'conv-1' } } });
  });

  test('a stolen cloud token alone (unapproved key) cannot command the desktop', () => {
    const attacker = makeClient();
    const res = verifySignedFrame(signedFrame(attacker, goodPayload(attacker)), ctxFor([]));
    expect(res).toEqual({ ok: false, reason: 'client_not_approved' });
  });

  test('a compromised relay cannot forge commands: wrong signature, swapped stamp, other user', () => {
    const c = makeClient();
    const other = makeClient();
    const approved = [approvedEntry(c), approvedEntry(other)];
    // Relay tampers with the signed payload.
    const frame = signedFrame(c, goodPayload(c));
    frame.signed = frame.signed.replace('chat', 'cancel');
    expect(verifySignedFrame(frame, ctxFor(approved))).toEqual({ ok: false, reason: 'bad_signature' });
    // Relay re-stamps a frame signed by one approved client as another.
    expect(verifySignedFrame(signedFrame(c, goodPayload(c), { clientId: other.clientId }), ctxFor(approved))).toEqual({ ok: false, reason: 'bad_signature' });
    // A different Sulla Cloud user.
    expect(verifySignedFrame(signedFrame(c, goodPayload(c), { userId: 'someone-else' }), ctxFor(approved))).toEqual({ ok: false, reason: 'wrong_user' });
  });

  test('replays, stale frames and frames for another desktop are refused', () => {
    const c = makeClient();
    const nonces = new NonceCache();
    const ctx = ctxFor([approvedEntry(c)], nonces);
    const frame = signedFrame(c, goodPayload(c));
    expect(verifySignedFrame(frame, ctx).ok).toBe(true);
    expect(verifySignedFrame(frame, ctx)).toEqual({ ok: false, reason: 'replay' });
    expect(verifySignedFrame(signedFrame(c, goodPayload(c, { ts: NOW - 3 * 60_000 })), ctx)).toEqual({ ok: false, reason: 'stale' });
    expect(verifySignedFrame(signedFrame(c, goodPayload(c, { deviceId: 'device-2' })), ctx)).toEqual({ ok: false, reason: 'wrong_device' });
    expect(verifySignedFrame(signedFrame(c, goodPayload(c, { clientId: 'x' })), ctx)).toEqual({ ok: false, reason: 'client_mismatch' });
  });

  test('only chat/inject/cancel/companion_request bodies are allowed', () => {
    const c = makeClient();
    for (const type of ['exec', 'settings.set', 'pair_request', 'deliver']) {
      const res = verifySignedFrame(signedFrame(c, goodPayload(c, { body: { type } })), ctxFor([approvedEntry(c)]));
      expect(res).toEqual({ ok: false, reason: 'unsupported_command' });
    }
  });

  test('a rejected frame does not burn its nonce', () => {
    const c = makeClient();
    const nonces = new NonceCache();
    const payload = goodPayload(c);
    // Same nonce first arrives for the wrong device (rejected), then correctly.
    expect(verifySignedFrame(signedFrame(c, { ...payload, deviceId: 'device-2' }), ctxFor([approvedEntry(c)], nonces)).ok).toBe(false);
    expect(verifySignedFrame(signedFrame(c, payload), ctxFor([approvedEntry(c)], nonces)).ok).toBe(true);
  });
});

describe('pairing', () => {
  test('pairing code is 6 digits and bound to both device and key', () => {
    const a = makeClient();
    const b = makeClient();
    expect(pairingCode('device-1', a.pub)).toMatch(/^\d{6}$/);
    expect(pairingCode('device-1', a.pub)).toBe(pairingCode('device-1', a.pub));
    expect(pairingCode('device-2', a.pub)).not.toBe(pairingCode('device-1', a.pub));
    expect(pairingCode('device-1', b.pub)).not.toBe(pairingCode('device-1', a.pub));
  });

  test('pair request key must match the stamped client id and the owner', () => {
    const a = makeClient();
    const b = makeClient();
    const req = (pub: string, from: Record<string, unknown>) => ({ type: 'client_frame', kind: 'pair_request', publicKey: pub, label: 'Chrome\u0007 on Mac', from } as any);
    const ok = checkPairRequest(req(a.pub, { userId: 'owner', clientId: a.clientId, surface: 'web' }), 'owner');
    expect(ok).toMatchObject({ ok: true, clientId: a.clientId, label: 'Chrome  on Mac' });
    expect(checkPairRequest(req(a.pub, { userId: 'owner', clientId: b.clientId }), 'owner')).toEqual({ ok: false, reason: 'client_mismatch' });
    expect(checkPairRequest(req(a.pub, { userId: 'intruder', clientId: a.clientId }), 'owner')).toEqual({ ok: false, reason: 'wrong_user' });
    expect(checkPairRequest(req('short', { userId: 'owner', clientId: a.clientId }), 'owner')).toEqual({ ok: false, reason: 'bad_key' });
  });
});

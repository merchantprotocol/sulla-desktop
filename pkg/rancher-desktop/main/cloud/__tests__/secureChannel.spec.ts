/** @jest-environment node */
import crypto from 'crypto';

import { jest } from '@jest/globals';

import mockModules from '@pkg/utils/testUtils/mockModules';

const approved = new Map<string, any>();
const prefs = { conversations: false, vault: false, projects: false, remoteAccess: true };

mockModules({
  '@pkg/utils/logging':              { __esModule: true, default: { background: { log: jest.fn(), warn: jest.fn(), error: jest.fn() } } },
  '@pkg/main/deviceIdentity':        { getDesktopDeviceId: () => Promise.resolve('device-1') },
  '@pkg/main/sullaCloudAuth':        { getCurrentAccessToken: () => Promise.resolve('token'), getCurrentUserId: () => Promise.resolve('owner') },
  '@pkg/main/cloud/cloudSettings':   { getCloudPreferences: () => Promise.resolve(({ ...prefs })) },
  '@pkg/main/cloud/deviceKey':       { signDeviceMessage: () => ({ ts: 1, signature: 's' }) },
  '@pkg/main/cloud/approvedClients': {
    ApprovedClients: {
      get:    (id: string) => approved.get(id),
      add:    (c: any) => approved.set(c.clientId, c),
      remove: (id: string) => approved.delete(id),
      list:   () => [...approved.values()],
      touch:  () => undefined,
    },
  },
});

const { SecureDesktopChannel } = await import('@pkg/main/cloud/secureChannel');
const { clientIdFromPublicKey, pairingCode } = await import('@pkg/main/cloud/secureChannelProtocol');

function makeClient() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const pub = Buffer.from((publicKey.export({ format: 'jwk' }) as any).x, 'base64url').toString('base64');
  return { privateKey, pub, clientId: clientIdFromPublicKey(pub) };
}

function signed(c: ReturnType<typeof makeClient>, body: Record<string, unknown>) {
  const s = JSON.stringify({ v: 1, deviceId: 'device-1', clientId: c.clientId, ts: Date.now(), nonce: crypto.randomBytes(16).toString('base64'), body });
  return JSON.stringify({
    type:   'client_frame',
    kind:   'signed',
    from:   { userId: 'owner', clientId: c.clientId, surface: 'web' },
    signed: s,
    sig:    crypto.sign(null, Buffer.from(s), c.privateKey).toString('base64'),
  });
}

function setup(promptAnswer = true) {
  const sent: any[] = [];
  const ws = { readyState: 1, send: (m: string) => sent.push(JSON.parse(m)) };
  (globalThis as any).WebSocket = { OPEN: 1 };
  const prompt = jest.fn(() => Promise.resolve(promptAnswer));
  const dispatch = jest.fn((body: any, reply: any, respond: any) => {
    if (body.type === 'companion_request') respond({ type: 'companion_response', requestId: body.requestId, result: { ok: 1 } });
    else reply({ type: 'ack', conversationId: body.conversationId });

    return Promise.resolve();
  });
  const ch = new SecureDesktopChannel({ prompt, dispatch });
  ch._setIdentity('owner', 'device-1', ws);
  return { ch, sent, prompt, dispatch };
}

beforeEach(() => {
  approved.clear();
  prefs.remoteAccess = true;
});

test('pairing: the owner approves at the desktop, code matches what the browser shows', async() => {
  const { ch, sent, prompt } = setup(true);
  const c = makeClient();
  await ch.onMessage(JSON.stringify({ type: 'client_frame', kind: 'pair_request', publicKey: c.pub, label: 'Chrome on Mac', from: { userId: 'owner', clientId: c.clientId, surface: 'web' } }));
  expect(prompt).toHaveBeenCalledWith({ label: 'Chrome on Mac', surface: 'web', code: pairingCode('device-1', c.pub) });
  expect(sent.map(f => f.frame.type)).toEqual(['pair_pending', 'pair_result']);
  expect(sent[1]).toEqual({ type: 'deliver', to: c.clientId, frame: { type: 'pair_result', approved: true } });
  expect(approved.has(c.clientId)).toBe(true);
});

test('pairing: denied at the desktop means nothing is stored', async() => {
  const { ch, sent } = setup(false);
  const c = makeClient();
  await ch.onMessage(JSON.stringify({ type: 'client_frame', kind: 'pair_request', publicKey: c.pub, from: { userId: 'owner', clientId: c.clientId } }));
  expect(sent.at(-1).frame).toEqual({ type: 'pair_result', approved: false });
  expect(approved.size).toBe(0);
});

test('commands from an unapproved key never reach the agent', async() => {
  const { ch, sent, dispatch } = setup();
  const c = makeClient();
  await ch.onMessage(signed(c, { type: 'chat', conversationId: 'conv-1' }));
  expect(dispatch).not.toHaveBeenCalled();
  expect(sent.at(-1)).toEqual({ type: 'deliver', to: c.clientId, frame: { type: 'error', reason: 'client_not_approved' } });
});

test('approved commands dispatch; conversation replies go to its followers only', async() => {
  const { ch, sent, dispatch } = setup();
  const a = makeClient();
  const b = makeClient();
  approved.set(a.clientId, { clientId: a.clientId, publicKey: a.pub });
  approved.set(b.clientId, { clientId: b.clientId, publicKey: b.pub });
  await ch.onMessage(signed(a, { type: 'chat', conversationId: 'conv-1' }));
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(sent.at(-1)).toEqual({ type: 'deliver', to: a.clientId, frame: { type: 'ack', conversationId: 'conv-1' } });

  // A second approved browser joins the same conversation; both follow it.
  await ch.onMessage(signed(b, { type: 'chat', conversationId: 'conv-1' }));
  const last2 = sent.slice(-2).map(f => f.to).sort();
  expect(last2).toEqual([a.clientId, b.clientId].sort());
});

test('remote access switched off at the desktop refuses even approved clients', async() => {
  const { ch, sent, dispatch } = setup();
  const a = makeClient();
  approved.set(a.clientId, { clientId: a.clientId, publicKey: a.pub });
  prefs.remoteAccess = false;
  await ch.onMessage(signed(a, { type: 'chat', conversationId: 'conv-1' }));
  expect(dispatch).not.toHaveBeenCalled();
  expect(sent.at(-1).frame).toEqual({ type: 'error', reason: 'remote_access_disabled' });
});

test('revoking a client forgets the key and tells the relay to kick it', async() => {
  const { ch, sent, dispatch } = setup();
  const a = makeClient();
  approved.set(a.clientId, { clientId: a.clientId, publicKey: a.pub });
  ch.revokeClient(a.clientId);
  expect(sent.at(-1)).toEqual({ type: 'revoke_client', clientId: a.clientId });
  await ch.onMessage(signed(a, { type: 'chat', conversationId: 'conv-1' }));
  expect(dispatch).not.toHaveBeenCalled();
});

test('only one pairing dialog at a time, and at most 5 per 10 minutes', async() => {
  let release!: (v: boolean) => void;
  const sent: any[] = [];
  (globalThis as any).WebSocket = { OPEN: 1 };
  const ch = new SecureDesktopChannel({ prompt: () => new Promise<boolean>((resolve) => { release = resolve }), dispatch: jest.fn() as any });
  ch._setIdentity('owner', 'device-1', { readyState: 1, send: (m: string) => sent.push(JSON.parse(m)) });
  const a = makeClient();
  const b = makeClient();
  const first = ch.onMessage(JSON.stringify({ type: 'client_frame', kind: 'pair_request', publicKey: a.pub, from: { userId: 'owner', clientId: a.clientId } }));
  await new Promise((resolve) => { setImmediate(resolve) });
  await ch.onMessage(JSON.stringify({ type: 'client_frame', kind: 'pair_request', publicKey: b.pub, from: { userId: 'owner', clientId: b.clientId } }));
  expect(sent.at(-1)).toEqual({ type: 'deliver', to: b.clientId, frame: { type: 'pair_result', approved: false, reason: 'pairing_busy' } });
  release(false);
  await first;
});

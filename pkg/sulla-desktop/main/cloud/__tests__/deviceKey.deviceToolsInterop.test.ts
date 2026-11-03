// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-device-key-interop-'));

jest.unstable_mockModule('@pkg/utils/paths', () => ({
  default: { sullaConfig: configDir },
}));

const deviceKey = await import('../deviceKey');

const PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f
-----END PRIVATE KEY-----
`;
const PUBLIC_KEY = 'A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=';
const GOLDEN_SIGNATURE = 'lQ9TSQ00iWCog0R4kaZ3AVZ9oE17laRVjDJLbmwM+D56an2LAzdVCXP1TuPvnzMTRpIRX+BUfeZ+aQvzD+btAw==';

const envelope = {
  v: 1,
  targetDeviceId: 'app-12345678',
  callerDeviceId: 'desktop-12345678',
  ts: 1793412000,
  nonce: 'nonce-12345678',
  callId: 'call-12345678',
  body: {
    jsonrpc: '2.0',
    id: 'call-12345678',
    method: 'tools/call',
    params: { name: 'list_projects', arguments: { limit: 10, includeArchived: false } },
  },
} as const;

// Ported verbatim from AVL src/cloud/envelope.js. This is intentionally
// independent of CloudDeviceTransport's implementation so drift is caught.
function avlCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) as string;
  if (Array.isArray(value)) return `[${ value.map(avlCanonicalJson).join(',') }]`;
  const object = value as Record<string, unknown>;
  return `{${ Object.keys(object).sort()
    .map(key => `${ JSON.stringify(key) }:${ avlCanonicalJson(object[key]) }`).join(',') }}`;
}

function avlVerify(candidate: unknown, signature: string): boolean {
  const digest = crypto.createHash('sha256').update(avlCanonicalJson(candidate)).digest('hex');
  const message = deviceKey.deviceMessage('device-tools-rpc-v1', [
    'user-12345678', envelope.callerDeviceId, envelope.targetDeviceId, envelope.callId, envelope.ts, digest,
  ]);
  const raw = Buffer.from(PUBLIC_KEY, 'base64');
  const publicKey = crypto.createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]),
    format: 'der',
    type: 'spki',
  });
  return crypto.verify(null, Buffer.from(message), publicKey, Buffer.from(signature, 'base64'));
}

describe('device-tools signature interoperability', () => {
  beforeAll(() => {
    fs.writeFileSync(path.join(configDir, 'device-key.json'), JSON.stringify({
      v: 1,
      publicKey: PUBLIC_KEY,
      privateKey: PRIVATE_KEY,
      createdAt: '2026-10-31T00:00:00.000Z',
    }));
    deviceKey._resetDeviceKeyCache();
  });

  afterAll(() => {
    deviceKey._resetDeviceKeyCache();
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it('produces the golden signature AVL verifies and rejects a tampered body', () => {
    const digest = crypto.createHash('sha256').update(avlCanonicalJson(envelope)).digest('hex');
    const signature = deviceKey.signDeviceMessageExact('device-tools-rpc-v1', [
      'user-12345678', envelope.callerDeviceId, envelope.targetDeviceId, envelope.callId, envelope.ts, digest,
    ]);

    expect(deviceKey.getDevicePublicKey()).toBe(PUBLIC_KEY);
    expect(signature).toBe(GOLDEN_SIGNATURE);
    expect(avlVerify(envelope, signature)).toBe(true);
    expect(avlVerify({ ...envelope, body: { ...envelope.body, method: 'tools/list' } }, signature)).toBe(false);
  });
});

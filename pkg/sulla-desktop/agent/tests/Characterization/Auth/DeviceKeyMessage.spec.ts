// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DeviceMessage, type DevicePurpose as DomainDevicePurpose } from '@sulla/domain';

// Key custody stays in main; the spec gives it a throwaway config directory.
vi.mock('@pkg/utils/paths', () => ({ default: { get sullaConfig() { return process.env.SULLA_TEST_DEVICE_KEY_DIR as string; } } }));

import { _resetDeviceKeyCache, deviceMessage, getDevicePublicKey, signDeviceMessage, signDeviceMessageExact, type DevicePurpose } from '../../../../main/cloud/deviceKey';

/** The tag table the removed builder in deviceKey.ts used (10 of the 16 purposes). */
class LegacyDeviceMessageBuilder {
  static readonly TAGS: Record<string, string> = {
    'relay-desktop': 'sulla-relay-desktop-v1',
    'sync-upload':   'sulla-sync-upload-v1',
    'key-rotate':    'sulla-key-rotate-v1',
    'vault-sync-v3': 'sulla-vault-sync-v3',
    'files-sync-v1': 'sulla-files-sync-v1',
    'device-tools-rpc-v1': 'sulla-device-tools-rpc-v1',
    'device-tools-host-v1': 'sulla-device-tools-host-v1',
    'support-desktop-v1': 'sulla-support-desktop-v1',
    'support-request-v1': 'sulla-support-request-v1',
    'support-guest-v1': 'sulla-support-guest-v1',
  };

  build(purpose: string, parts: (string | number)[]): Buffer {
    return Buffer.from([LegacyDeviceMessageBuilder.TAGS[purpose], ...parts.map(String)].join('\n'));
  }
}

const legacy = new LegacyDeviceMessageBuilder();
const PARTS = ['user-1', 'device-1', 'op', 42];
const ALL = Object.keys(DeviceMessage.PURPOSE_TAGS) as DomainDevicePurpose[];
let dir = '';

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-device-key-spec-'));
  process.env.SULLA_TEST_DEVICE_KEY_DIR = dir;
  _resetDeviceKeyCache();
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.SULLA_TEST_DEVICE_KEY_DIR;
  _resetDeviceKeyCache();
});

describe('deviceKey signed message (domain DeviceMessage registry)', () => {
  it('builds the same bytes as the old builder for each of the 10 purposes Desktop already signed', () => {
    // risk: every device signature is rejected by Cloud if a tag or the framing changes by one byte.
    for (const purpose of Object.keys(LegacyDeviceMessageBuilder.TAGS) as DomainDevicePurpose[]) {
      expect(Buffer.from(deviceMessage(purpose, PARTS)), purpose).toEqual(legacy.build(purpose, PARTS));
    }
  });

  it('signs Slack purposes with the exact worker-verifier tags and rejects newline framing', () => {
    // risk: Slack workspace/inbound signatures must use the server-verified purpose tags and canonical fields.
    const slackTags = {
      'slack-inbound-v1': 'sulla-slack-inbound-v1',
      'slack-workspace-v1': 'sulla-slack-workspace-v1',
    } as const;
    const publicKey = crypto.createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(getDevicePublicKey(), 'base64').toString('base64url') },
      format: 'jwk',
    });
    for (const [purpose, tag] of Object.entries(slackTags) as [keyof typeof slackTags, string][]) {
      const expected = Buffer.from([tag, ...PARTS.map(String)].join('\n'));
      const exact = signDeviceMessageExact(purpose, PARTS);
      expect(Buffer.from(deviceMessage(purpose, PARTS))).toEqual(expected);
      expect(crypto.verify(null, expected, publicKey, Buffer.from(exact, 'base64'))).toBe(true);
      const { ts, signature } = signDeviceMessage(purpose, PARTS);
      expect(crypto.verify(null, Buffer.from([tag, ...PARTS.map(String), String(ts)].join('\n')), publicKey, Buffer.from(signature, 'base64'))).toBe(true);
      expect(() => deviceMessage(purpose, ['bad\npart'])).toThrow('newlines');
    }
  });

  it('signs the 6 other registry purposes with their real tag, never an empty one', () => {
    // risk: before, these signed "\nuser-1..." (an empty tag) that Cloud could never verify.
    const others = ALL.filter(purpose => !(purpose in LegacyDeviceMessageBuilder.TAGS));
    expect(others).toHaveLength(6);
    for (const purpose of others) {
      const message = deviceMessage(purpose, PARTS);
      expect(message.startsWith(`${ DeviceMessage.PURPOSE_TAGS[purpose] }\n`), purpose).toBe(true);
      expect(DeviceMessage.PURPOSE_TAGS[purpose].length).toBeGreaterThan(0);
    }
  });

  it('refuses a part with a newline and an unknown purpose', () => {
    // risk: a newline lets two different field lists produce the same signed bytes; an unknown purpose signed an empty tag.
    expect(() => deviceMessage('vault-sync-v3', ['user\n1', 'device'])).toThrow('newlines');
    expect(() => signDeviceMessage('sync-upload', ['a\nb'])).toThrow('newlines');
    expect(() => signDeviceMessageExact('sync-upload', [1, 'a\nb'])).toThrow('newlines');
    expect(() => deviceMessage('made-up-purpose' as DevicePurpose, PARTS)).toThrow('unknown device purpose');
    expect(() => signDeviceMessageExact('toString' as DevicePurpose, PARTS)).toThrow('unknown device purpose');
  });

  it('signs the registry bytes: the signature verifies against the device public key', () => {
    // risk: forged-or-rejected identity — the signature must cover exactly tag + parts (+ ts).
    const publicKey = crypto.createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(getDevicePublicKey(), 'base64').toString('base64url') },
      format: 'jwk',
    });
    for (const purpose of ALL) {
      const exact = signDeviceMessageExact(purpose, PARTS);
      expect(crypto.verify(null, new DeviceMessage(purpose, PARTS).toBytes(), publicKey, Buffer.from(exact, 'base64')), purpose).toBe(true);

      const { ts, signature } = signDeviceMessage(purpose, PARTS);
      const signed = new DeviceMessage(purpose, [...PARTS, ts]).toBytes();
      expect(crypto.verify(null, signed, publicKey, Buffer.from(signature, 'base64')), purpose).toBe(true);
      expect(crypto.verify(null, new DeviceMessage(purpose, PARTS).toBytes(), publicKey, Buffer.from(signature, 'base64'))).toBe(false);
    }
  });
});

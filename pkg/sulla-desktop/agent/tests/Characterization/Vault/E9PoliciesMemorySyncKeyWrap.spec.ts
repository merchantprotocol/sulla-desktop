// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// E9 policies: known-answer and legacy-equivalence specs for the memory-sync key wrap.
// risk: data loss / secret disclosure — a memory key wrapped before the OOP move must unwrap
// byte-identically after it, and wrong keys, wrong users or tampered blobs must still fail closed.

import { webcrypto } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import * as live from '../../../../../../services/sulla-vault/src/memorySyncKeyWrap';
import * as legacy from '../../Support/E9Legacy/memorySyncKeyWrap.legacy';

class DeterministicNonce {
  private readonly original = webcrypto.getRandomValues;

  /** Every getRandomValues call fills bytes (seed + index) & 0xff until restore(). */
  install(seed: number): void {
    const fill = <T extends ArrayBufferView | null>(array: T): T => {
      const bytes = new Uint8Array((array as unknown as Uint8Array).buffer, (array as unknown as Uint8Array).byteOffset, (array as unknown as Uint8Array).byteLength);
      for (let i = 0; i < bytes.length; i++) bytes[i] = (seed + i) & 0xff;
      return array;
    };
    (webcrypto as { getRandomValues: unknown }).getRandomValues = fill;
  }

  restore(): void {
    (webcrypto as { getRandomValues: unknown }).getRandomValues = this.original;
  }
}

const bytes = (length: number, start: number, step = 1) => Uint8Array.from({ length }, (_, i) => (start + i * step) & 0xff);
const outcome = async(run: () => Promise<unknown>): Promise<string> => {
  try {
    const value = await run();
    return value instanceof Uint8Array ? `ok:${ Buffer.from(value).toString('hex') }` : `ok:${ String(value) }`;
  } catch (error) {
    const e = error as Error;
    return `throw:${ e.constructor.name }:${ e.message }`;
  }
};

const nonce = new DeterministicNonce();
afterEach(() => nonce.restore());

describe('E9 policies: memorySyncKeyWrap known answers', () => {
  it('wraps a fixed key under a fixed nonce to the exact recorded blob (captured from ddbe28884)', async() => {
    nonce.install(0xa0);
    const userKey = bytes(32, 0);
    const memoryKey = bytes(32, 255, -1);
    const wrapped = await live.wrapMemorySyncKey(userKey, 'user-1', memoryKey);
    expect(wrapped).toBe('oKGio6SlpqeoqaqrGeaB0b4x+0eVk3In9IgxLp9CtPx5XauEe+jDYpxJlOH6RrlOTkLDNIHoGiqFklkR');
    nonce.restore();
    expect(Buffer.from(await live.unwrapMemorySyncKey(userKey, 'user-1', wrapped)).toString('hex'))
      .toBe('fffefdfcfbfaf9f8f7f6f5f4f3f2f1f0efeeedecebeae9e8e7e6e5e4e3e2e1e0');
    // nonce(12) || ciphertext(32) || tag(16)
    expect(Buffer.from(wrapped, 'base64').subarray(0, 12).toString('hex')).toBe('a0a1a2a3a4a5a6a7a8a9aaab');
    expect(Buffer.from(wrapped, 'base64').byteLength).toBe(60);
  });
});

describe('E9 policies: memorySyncKeyWrap legacy == live', () => {
  const userIds = ['user-1', 'u', '00000000-0000-4000-8000-000000000001', 'ü', 'a|b', 'x'.repeat(300)];

  it('produces identical wraps for the same keys, user and nonce, and each side unwraps the other', async() => {
    for (let c = 0; c < 24; c++) {
      const userKey = bytes(32, c * 7, 3);
      const memoryKey = bytes(32, 200 - c, 5);
      const userId = userIds[c % userIds.length];
      nonce.install(c * 11);
      const before = await legacy.wrapMemorySyncKey(userKey, userId, memoryKey);
      const after = await live.wrapMemorySyncKey(userKey, userId, memoryKey);
      nonce.restore();
      expect(after, `case ${ c }`).toBe(before);
      expect(Buffer.from(await live.unwrapMemorySyncKey(userKey, userId, before))).toEqual(Buffer.from(memoryKey));
      expect(Buffer.from(await legacy.unwrapMemorySyncKey(userKey, userId, after))).toEqual(Buffer.from(memoryKey));
    }
  });

  it('uses a fresh random nonce per wrap (no fixed or reused IV)', async() => {
    const userKey = bytes(32, 1);
    const memoryKey = bytes(32, 2);
    const first = await live.wrapMemorySyncKey(userKey, 'user-1', memoryKey);
    const second = await live.wrapMemorySyncKey(userKey, 'user-1', memoryKey);
    expect(first).not.toBe(second);
  });

  it('rejects bad wrap inputs with the same errors', async() => {
    const cases: [Uint8Array, string, Uint8Array][] = [
      [bytes(31, 0), 'user-1', bytes(32, 0)], [bytes(33, 0), 'user-1', bytes(32, 0)], [bytes(32, 0), '', bytes(32, 0)],
      [bytes(32, 0), 'user-1', bytes(31, 0)], [bytes(32, 0), 'user-1', bytes(16, 0)], [bytes(0, 0), '', bytes(0, 0)],
    ];
    for (const [userKey, userId, memoryKey] of cases) {
      nonce.install(1);
      const before = await outcome(() => legacy.wrapMemorySyncKey(userKey, userId, memoryKey));
      const after = await outcome(() => live.wrapMemorySyncKey(userKey, userId, memoryKey));
      nonce.restore();
      expect(after).toBe(before);
      expect(after).toBe('throw:Error:invalid_request');
    }
  });

  it('fails unwrap the same way for wrong keys, wrong users, tampering and malformed blobs', async() => {
    const userKey = bytes(32, 9);
    const memoryKey = bytes(32, 77);
    nonce.install(0x10);
    const wrapped = await legacy.wrapMemorySyncKey(userKey, 'user-1', memoryKey);
    nonce.restore();
    const packed = Buffer.from(wrapped, 'base64');
    const flip = (index: number) => { const copy = Buffer.from(packed); copy[index] ^= 0x01; return copy.toString('base64'); };
    const cases: [Uint8Array, string, unknown, string][] = [
      [userKey, 'user-1', wrapped, 'ok'],
      [bytes(32, 10), 'user-1', wrapped, 'throw:Error:memory_key_unwrap_failed'],
      [userKey, 'user-2', wrapped, 'throw:Error:memory_key_unwrap_failed'],
      [userKey, 'user-1', flip(0), 'throw:Error:memory_key_unwrap_failed'],
      [userKey, 'user-1', flip(20), 'throw:Error:memory_key_unwrap_failed'],
      [userKey, 'user-1', flip(59), 'throw:Error:memory_key_unwrap_failed'],
      [userKey, 'user-1', packed.subarray(0, 59).toString('base64'), 'throw:Error:invalid_request'],
      [userKey, 'user-1', Buffer.concat([packed, Buffer.from([0])]).toString('base64'), 'throw:Error:invalid_request'],
      [userKey, 'user-1', '', 'throw:Error:invalid_request'],
      [userKey, 'user-1', 'A'.repeat(4097), 'throw:Error:invalid_request'],
      [userKey, 'user-1', `${ wrapped }${ ' '.repeat(4096 - wrapped.length) }`, 'ok'],
      [userKey, 'user-1', 42, 'throw:Error:invalid_request'],
      [userKey, 'user-1', null, 'throw:Error:invalid_request'],
      [userKey, '', wrapped, 'throw:Error:invalid_request'],
      [bytes(16, 9), 'user-1', wrapped, 'throw:Error:invalid_request'],
      [userKey, 'user-1', wrapped.replace(/=+$/, ''), 'ok'],
    ];
    for (const [key, userId, blob, expected] of cases) {
      const before = await outcome(() => legacy.unwrapMemorySyncKey(key, userId, blob as string));
      const after = await outcome(() => live.unwrapMemorySyncKey(key, userId, blob as string));
      expect(after, JSON.stringify([userId, typeof blob === 'string' ? blob.length : blob])).toBe(before);
      expect(after.startsWith(expected), `${ after } should start with ${ expected }`).toBe(true);
    }
  });
});

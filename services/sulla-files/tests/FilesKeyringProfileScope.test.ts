// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';
import { FilesKeyring } from '../src/keyring.js';

type Internals = { master: Buffer; cache: Map<string, { data: Uint8Array; dedup: Uint8Array }> };

describe('FilesKeyring profile scope', () => {
  it('returns independent key buffers and close only zeroizes the private cache', async() => {
    // risk: data integrity — lock/restart must not mutate key bytes already held by an in-flight writer.
    const keyring = new FilesKeyring({} as never);
    const internals = keyring as unknown as Internals;
    internals.master = Buffer.alloc(32, 1);
    const cached = { data:Buffer.alloc(32, 0x31), dedup:Buffer.alloc(32, 0x32) };
    internals.cache.set(`profile_unscoped\u0000col-1`, cached);
    const first = await keyring.keys('col-1'); const second = await keyring.keys('col-1');
    expect(first.data).not.toBe(second.data); expect(first.dedup).not.toBe(second.dedup);
    keyring.close();
    expect(first.data.every(byte => byte === 0x31)).toBe(true);
    expect(first.dedup.every(byte => byte === 0x32)).toBe(true);
  });

  it('zeroizes cached collection keys for one profile and keeps the other', () => {
    // risk: key lifecycle — sign-out of one account must erase only that account's collection keys.
    let active = 'profile_a';
    const keyring = new FilesKeyring({} as never, undefined, undefined, undefined, undefined, () => active);
    const internals = keyring as unknown as Internals;
    internals.master = Buffer.alloc(32, 1);
    const keysA = { data: Buffer.alloc(32, 0xaa), dedup: Buffer.alloc(32, 0xab) };
    const keysB = { data: Buffer.alloc(32, 0xba), dedup: Buffer.alloc(32, 0xbb) };
    internals.cache.set('profile_a\u0000col-1', keysA);
    internals.cache.set('profile_b\u0000col-1', keysB);
    keyring.invalidateProfile('profile_a');
    expect(keysA.data.every(byte => byte === 0) && keysA.dedup.every(byte => byte === 0)).toBe(true);
    expect(internals.cache.has('profile_a\u0000col-1')).toBe(false);
    expect(internals.cache.get('profile_b\u0000col-1')).toBe(keysB);
    expect(keysB.data.every(byte => byte === 0xba)).toBe(true);
    active = 'profile_b';
    expect(internals.cache.get(`profile_b\u0000col-1`)).toBe(keysB);
    keyring.close();
  });
});

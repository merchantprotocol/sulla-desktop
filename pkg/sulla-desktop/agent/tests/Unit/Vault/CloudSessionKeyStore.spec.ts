// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
import type { AccountKdf } from '@sulla/domain';

import { CloudSessionKeyStore } from '../../../../main/cloud/session/CloudSessionKeyStore';

describe('CloudSessionKeyStore', () => {
  const kdf = { algorithm: 'synthetic-test-fixture' } as unknown as AccountKdf;

  it('zeros a replaced key and retains only the latest session context', () => {
    // risk: secret material — replacement must erase old key bytes before the new session is retained.
    const store = new CloudSessionKeyStore(vi.fn());
    const oldKey = Uint8Array.from([1, 2, 3]);
    const currentKey = Uint8Array.from([4, 5, 6]);

    store.retain(oldKey, kdf, 'old-user');
    store.retain(currentKey, kdf, 'current-user');

    expect([...oldKey]).toEqual([0, 0, 0]);
    expect(store.context()).toEqual({ key: currentKey, kdf, userId: 'current-user' });
  });

  it('transfers key ownership to the caller without clearing it', () => {
    // risk: secret material — the consumer owns zeroization after take succeeds.
    const store = new CloudSessionKeyStore(vi.fn());
    const key = Uint8Array.from([7, 8]);
    store.retain(key, kdf, 'user');

    expect(store.take()).toBe(key);
    store.clear();
    expect([...key]).toEqual([7, 8]);
    expect(store.context()).toEqual({ key: undefined, kdf: undefined, userId: undefined });
  });

  it('zeros the retained key through the registered process-exit cleanup', () => {
    // risk: secret material — transient key bytes must not remain resident after shutdown cleanup.
    let onExit: (() => void) | undefined;
    const store = new CloudSessionKeyStore(cleanup => { onExit = cleanup; });
    const key = Uint8Array.from([9, 10]);
    store.retain(key, kdf, 'user');

    expect(onExit).toBeDefined();
    onExit?.();
    expect([...key]).toEqual([0, 0]);
    expect(store.context()).toEqual({ key: undefined, kdf: undefined, userId: undefined });
  });
});

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
  it('lets first-run wiring read the retained key and user without consuming them', () => {
    // risk: data accuracy — sullaCloudAuth's hasPendingKey, enrollmentComplete and the
    // sulla-cloud:first-run-session masterKeyRetained flag only read context(); a read must
    // never take, clear or zero the key, or vault creation would run without the Cloud key.
    const store = new CloudSessionKeyStore(vi.fn());
    const key = Uint8Array.from([11, 12, 13]);
    store.retain(key, kdf, 'first-run-user');

    const pendingKey = store.context();
    expect(!!pendingKey.key).toBe(true);
    expect(pendingKey.key).toBe(key);
    expect(pendingKey.userId).toBe('first-run-user');

    // Repeated reads (poke loop, IPC polls) still see the same live key bytes.
    expect(store.context().key).toBe(key);
    expect([...key]).toEqual([11, 12, 13]);
    expect(store.take()).toBe(key);
  });

  it('reports no pending key to first-run wiring once the key is taken or cleared', () => {
    // risk: data accuracy — after enrollment consumes the key, hasPendingKey and masterKeyRetained must turn false.
    const store = new CloudSessionKeyStore(vi.fn());
    store.retain(Uint8Array.from([1]), kdf, 'user');
    store.take();
    expect(!!store.context().key).toBe(false);

    store.retain(Uint8Array.from([2]), kdf, 'user');
    store.clear();
    expect(!!store.context().key).toBe(false);
    expect(store.context().userId).toBeUndefined();
  });
});

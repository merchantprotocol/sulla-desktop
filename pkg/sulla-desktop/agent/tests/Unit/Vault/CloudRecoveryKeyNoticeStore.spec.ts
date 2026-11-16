// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';

import { CloudRecoveryKeyNoticeStore } from '../../../../main/cloud/session/CloudRecoveryKeyNoticeStore';
import { CloudRecoveryKeyServiceProvider } from '../../../../main/cloud/session/CloudRecoveryKeyServiceProvider';

describe('CloudRecoveryKeyNoticeStore', () => {
  const storage = { location: 'local-keychain' as const, label: 'This Mac', checkedAt: '2026-11-16T00:00:00.000Z' };
  const fixedClock = () => new Date('2026-11-16T07:30:00.000Z');

  it('holds the published notice until the owner acknowledges it', () => {
    // risk: data loss — a recovery key the owner never saw must stay available to the renderer until it is shown.
    const store = new CloudRecoveryKeyNoticeStore(fixedClock);

    const notice = store.publish('synthetic-recovery-key', storage);

    expect(notice).toEqual({ recoveryKey: 'synthetic-recovery-key', storage, madeAt: '2026-11-16T07:30:00.000Z' });
    expect(store.pending()).toBe(notice);
    expect(store.pending()).toBe(notice);
  });

  it('forgets the key once it has been shown', () => {
    // risk: secret material — an acknowledged recovery key must not stay readable over IPC.
    const store = new CloudRecoveryKeyNoticeStore(fixedClock);
    store.publish('synthetic-recovery-key', storage);

    store.clear();

    expect(store.pending()).toBeUndefined();
  });

  it('replaces an older unshown key with the newest one', () => {
    // risk: data accuracy — only the latest vault-issued recovery key is valid, so the older one must not be shown.
    let now = new Date('2026-11-16T07:30:00.000Z');
    const store = new CloudRecoveryKeyNoticeStore(() => now);
    store.publish('synthetic-old-key', storage);
    now = new Date('2026-11-16T07:31:00.000Z');

    store.publish('synthetic-new-key', storage);

    expect(store.pending()).toEqual({ recoveryKey: 'synthetic-new-key', storage, madeAt: '2026-11-16T07:31:00.000Z' });
  });

  it('starts empty and keeps state per provider instance', () => {
    // risk: isolation — provider instances must not share a notice through module state.
    const first = new CloudRecoveryKeyServiceProvider();
    const second = new CloudRecoveryKeyServiceProvider();

    first.notices.publish('synthetic-recovery-key', storage);

    expect(second.notices.pending()).toBeUndefined();
    expect(first.notices.pending()?.recoveryKey).toBe('synthetic-recovery-key');
  });
});

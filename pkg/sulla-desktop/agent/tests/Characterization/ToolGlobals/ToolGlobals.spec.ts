// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';
import { isBlockedDesktopTarget } from '../../../tools/desktop/desktop';

describe('tool globals characterization', () => {
  it('refuses every privacy-protected desktop target regardless of case', () => {
    for (const value of ['keychain access', '1password', 'bitwarden', 'localhost:4777']) {
      expect(isBlockedDesktopTarget(value)).toBe(true);
      expect(isBlockedDesktopTarget(value.toUpperCase())).toBe(true);
      expect(isBlockedDesktopTarget(`prefix ${value} suffix`)).toBe(true);
    }
    expect(isBlockedDesktopTarget('Calculator')).toBe(false);
    expect(isBlockedDesktopTarget(undefined)).toBe(false);
  });

  it('pins the request-publish decision event contract', () => {
    type Record = { id: string; kind: string; status: string; payload?: { filesPublishRequestId?: string } };
    const pending = new Set<string>();
    const notify = new Map<string, (message: string) => void>();
    const delivered: string[] = [];
    const onDecision = (record: Record) => {
      if (!record.payload?.filesPublishRequestId || record.kind !== 'approval' || record.status === 'pending' || record.status === 'deferred') return;
      if (pending.has(record.id)) return;
      pending.add(record.id);
      const send = notify.get(record.id);
      if (send) send(record.status === 'approved' ? 'File version publish approved.' : `File version publish request ${record.status}.`);
      pending.delete(record.id);
      notify.delete(record.id);
    };
    notify.set('publish-1', message => delivered.push(message));
    onDecision({ id: 'publish-1', kind: 'approval', status: 'pending', payload: { filesPublishRequestId: 'file-1' } });
    onDecision({ id: 'publish-1', kind: 'question', status: 'approved', payload: { filesPublishRequestId: 'file-1' } });
    onDecision({ id: 'publish-1', kind: 'approval', status: 'approved', payload: { filesPublishRequestId: 'file-1' } });
    expect(delivered).toEqual(['File version publish approved.']);
  });
});

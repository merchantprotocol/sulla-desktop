// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { SupportSessionReadiness } from './SupportSessionReadiness';

describe('SupportSessionReadiness', () => {
  const readiness = new SupportSessionReadiness();
  const now = Date.parse('2026-11-21T12:00:00Z');
  const session = {
    id: 'session-one', status: 'active', user: { id: 'customer-one' }, device: { id: 'device-one' },
    acceptedBy: 'supporter-one', approvedAt: '2026-11-21T11:00:00Z', expiresAt: '2026-11-21T13:00:00Z',
  };
  const binding = readiness.binding(session, session.id, now)!;
  const proof = { binding, validUntil: now + 1000 };

  // risk: permissions — actual RPC readiness cannot be inferred from presence.
  it('requires fresh evidence beyond an online device', () => {
    expect(readiness.connection(true, binding, true, null, now)).toBe('unverified');
    expect(readiness.connection(true, binding, true, proof, now)).toBe('rpc-ready');
    expect(readiness.connection(true, binding, true, proof, now + 1000)).toBe('unverified');
    expect(readiness.connection(true, binding, false, proof, now)).toBe('offline');
    expect(readiness.connection(true, binding, null, proof, now)).toBe('unverified');
    expect(readiness.connection(false, binding, true, proof, now)).toBe('inactive');
  });

  // risk: permissions — evidence from another session, account, device or approval cannot be reused.
  it('binds readiness to the exact approved support tuple', () => {
    expect(readiness.binding(session, 'other-session', now)).toBeNull();
    expect(readiness.binding({ ...session, approvedAt: '' }, session.id, now)).toBeNull();
    expect(readiness.binding({ ...session, expiresAt: 'invalid' }, session.id, now)).toBeNull();
    expect(readiness.binding(session, session.id, Date.parse(session.expiresAt))).toBeNull();
    for (const changed of [{ user: { id: 'other' } }, { device: { id: 'other' } }, { acceptedBy: 'other' }]) {
      const other = readiness.binding({ ...session, ...changed }, session.id, now);
      expect(other).not.toBe(binding);
      expect(readiness.connection(true, other, true, proof, now)).toBe('unverified');
    }
  });
});

// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { SupportSessionReadiness } from './SupportSessionReadiness';

describe('SupportSessionReadiness', () => {
  const readiness = new SupportSessionReadiness();

  // risk: supporters mistake an active approval for a reachable device
  it('requires both a verified active session and online presence', () => {
    expect(readiness.connection(true, true, undefined)).toBe('checking');
    expect(readiness.connection(true, true, false)).toBe('offline');
    expect(readiness.connection(true, true, true)).toBe('connected');
    expect(readiness.connection(false, true, true)).toBe('inactive');
  });

  // risk: stale success is reported as current after refresh failure
  it('does not trust cached active status after a denied session read or a failed presence read', () => {
    expect(readiness.connection(true, false, true)).toBe('unverified');
    expect(readiness.connection(true, true, null)).toBe('unverified');
    expect(readiness.connection(true, true, true)).toBe('connected');
  });
});

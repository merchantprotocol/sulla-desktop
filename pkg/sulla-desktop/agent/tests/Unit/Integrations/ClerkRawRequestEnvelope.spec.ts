// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { ClerkRawRequestEnvelope } from '../../../integrations/clerk/ClerkRawRequestEnvelope';

describe('ClerkRawRequestEnvelope', () => {
  const envelope = new ClerkRawRequestEnvelope();

  it('accepts only flat raw fields before defaults are applied', () => {
    expect(envelope.accepts({ path: '/users', method: 'GET' }, 'tool')).toBe(true);
    expect(envelope.accepts({ path: '/users', accountId: 'default' }, 'tool')).toBe(true);
    expect(envelope.accepts({ path: '/users', operationId: 'opaque-id' }, 'proxy')).toBe(true);
    expect(envelope.accepts({ path: '/users', accountId: 'default' }, 'proxy')).toBe(false);
    expect(envelope.accepts({ params: { path: '/users' } }, 'tool')).toBe(false);
    expect(envelope.accepts({ input: { path: '/users' } }, 'tool')).toBe(false);
    expect(envelope.accepts({ path: '/users', approvalId: 'arbitrary' }, 'tool')).toBe(false);
    expect(envelope.accepts(null, 'tool')).toBe(false);
  });

  it('names the unexpected top-level field instead of describing wrappers', () => {
    expect(envelope.refusal({ path: '/users', limit: 5 }, 'tool')).toMatch(/^Clerk raw_request does not accept the field "limit"\. Allowed top-level fields: method, path, query, body, confirm, environment, headers, operationId, accountId\./);
    expect(envelope.refusal({ path: '/users', accountId: 'default' }, 'proxy')).toContain('the field "accountId"');
    expect(envelope.refusal({ a: 1, b: 2, c: 3, d: 4 }, 'tool')).toContain('the fields "a", "b", "c" and 1 more');
    expect(envelope.refusal({ path: '/users' }, 'tool')).toBeUndefined();
  });

  it('never echoes a key-shaped or oversized field name', () => {
    const refusal = envelope.refusal({ sk_live_FIXTUREONLY: 1, ['x'.repeat(500)]: 1 }, 'tool')!;
    expect(refusal).toContain('"[REDACTED]"');
    expect(refusal).not.toContain('sk_live_');
    expect(refusal).not.toContain('x'.repeat(41));
  });
});

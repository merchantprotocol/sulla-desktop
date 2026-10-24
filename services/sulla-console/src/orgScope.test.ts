// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License. See LICENSE.

import assert from 'node:assert/strict';
import test from 'node:test';

import { requireOrganization } from './orgScope.js';

const session = { authenticated: true as const, identity: { issuer: 'test', subject: 'user-x' }, organizations: [{ id: 'org-x', name: 'X', slug: 'x', roles: ['member'], groups: [] }], expiresAt: new Date().toISOString() };
test('a member of org X cannot access org Y', () => {
  assert.throws(() => requireOrganization(session, 'org-y'), (error: Error & { status?: number }) => error.status === 403);
});

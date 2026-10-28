// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import assert from 'node:assert/strict';
import test from 'node:test';

import { AccessDenied, requireCollectionRight } from './rbac.js';

import type { Queryable } from './db.js';

test('a member without collection rights cannot read the collection', async() => {
  const db = {
    query: () => Promise.resolve({
      rows:     [{ role: 'member', can_view: false, can_use_by_agents: false, can_edit: false, can_manage: false }],
      rowCount: 1,
    }),
  } as unknown as Queryable;

  await assert.rejects(requireCollectionRight(db, 'member-id', 'collection-id', 'view'), AccessDenied);
});

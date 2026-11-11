// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';

import { CollectionRoleGate } from '../../../../../../services/sulla-files/src/acl.js';

describe('Files CollectionRoleGate', () => {
  const gate = new CollectionRoleGate();

  it('allows a role at or above the needed level', () => {
    // risk: availability — editors and managers must keep working.
    expect(gate.allows('manage', 'edit')).toBe(true);
    expect(gate.allows('edit', 'edit')).toBe(true);
    expect(gate.allows('view', 'view')).toBe(true);
  });

  it('refuses a role below the needed level', () => {
    // risk: permissions — a view-level member must not edit, move or delete.
    expect(gate.allows('view', 'edit')).toBe(false);
    expect(gate.allows('edit', 'manage')).toBe(false);
  });

  it('refuses unknown roles and rights by default', () => {
    // risk: permissions — an unrecognised role must never compare as allowed.
    expect(gate.allows(undefined, 'view')).toBe(false);
    expect(gate.allows('owner', 'view')).toBe(false);
    expect(gate.allows('toString', 'view')).toBe(false);
    expect(gate.allows('manage', 'superuser')).toBe(false);
  });
});

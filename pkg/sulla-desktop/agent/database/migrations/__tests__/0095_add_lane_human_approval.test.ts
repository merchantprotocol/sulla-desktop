// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from '@jest/globals';

import { down, up } from '../0095_add_lane_human_approval';

describe('0095_add_lane_human_approval', () => {
  it('adds an explicit fail-closed lane approval flag', () => {
    expect(up).toContain('requires_human_approval BOOLEAN NOT NULL DEFAULT false');
    expect(down).toContain('DROP COLUMN IF EXISTS requires_human_approval');
  });
});

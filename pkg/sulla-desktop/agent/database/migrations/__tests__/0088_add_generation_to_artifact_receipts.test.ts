// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from '@jest/globals';

import { down, up } from '../0088_add_generation_to_artifact_receipts';

describe('0088 add generation to artifact receipts migration', () => {
  it('adds a nullable generation column additively, without touching existing rows', () => {
    expect(up).toContain('work_artifact_receipts');
    expect(up).toContain('ADD COLUMN IF NOT EXISTS generation INTEGER');
    expect(up).not.toContain('DROP');
    expect(up).not.toContain('generation INTEGER NOT NULL');
  });

  it('down drops only what up added', () => {
    expect(down).toContain('DROP COLUMN IF EXISTS generation');
    expect(down).toContain('DROP INDEX IF EXISTS idx_work_artifact_receipts_task_generation');
  });
});

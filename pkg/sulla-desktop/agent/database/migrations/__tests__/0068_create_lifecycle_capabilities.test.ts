// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from '@jest/globals';

import { up } from '../0068_create_lifecycle_capabilities';

describe('0068_create_lifecycle_capabilities', () => {
  it('seeds all protected lifecycle capabilities and enforces one live stage owner', () => {
    for (const key of [
      'planning-council', 'todo-execution', 'in-review-verification',
      'durable-waits', 'stale-recovery',
    ]) {
      expect(up).toContain(`('${ key }'`);
    }
    expect(up).toContain('idx_work_task_stage_claims_one_live');
    expect(up).toContain("WHERE status = 'active'");
    expect(up).not.toContain('expires_at');
  });
});

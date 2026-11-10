// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { buildWakeContent } from '../../tools/agents/jobDelivery';

describe('orphaned child job delivery', () => {
  it('includes a recovered child result while retaining the orphan reason', () => {
    // risk: a recovered child contract gets hidden behind the manager failure notice
    const content = buildWakeContent('child-job', [{
      label: 'worker', status: 'completed', output: '[orphaned from failed manager manager-job#0: empty wake] answer: 42', threadId: 'child-thread',
    }], 'orphaned child result: manager failed');

    expect(content).toContain('orphaned child result: manager failed');
    expect(content).toContain('orphaned from failed manager manager-job#0');
    expect(content).toContain('answer: 42');
  });
});

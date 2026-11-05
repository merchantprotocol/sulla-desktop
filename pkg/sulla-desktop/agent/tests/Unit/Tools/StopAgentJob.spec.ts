// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { stopAgentJob } from '../../../tools/agents/stop_agent_job';

describe('stopAgentJob caller verification', () => {
  it('fails closed before job lookup when caller context is unavailable', async() => {
    // risk: authorization — missing tool-session metadata must never impersonate the human UI.
    const result = await stopAgentJob('any-job', undefined, 'attempt');
    expect(result.successBoolean).toBe(false);
    expect(result.responseString).toContain('cannot verify caller');
  });
});

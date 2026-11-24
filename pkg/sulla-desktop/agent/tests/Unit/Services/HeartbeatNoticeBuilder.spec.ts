// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { AgentOrchestratorMessageFormatter } from '../../../services/AgentOrchestratorMessageFormatter';
import { HeartbeatNoticeBuilder } from '../../../services/HeartbeatNoticeBuilder';

describe('HeartbeatNoticeBuilder', () => {
  it('appends a localized explanatory notice after the orchestrator-framed heartbeat message', () => {
    // risk: a delegated agent mistakes a heartbeat for a fresh manager instruction and leaves it running.
    const builder = new HeartbeatNoticeBuilder('America/Los_Angeles');
    const formatter = new AgentOrchestratorMessageFormatter();
    const delivered = formatter.format(builder.buildMessage({
      message: 'Review the open task and continue.',
      intervalMinutes: 15,
      startedAt: Date.UTC(2026, 10, 24, 20, 0),
      expiresAt: Date.UTC(2026, 10, 25, 2, 0),
      setBy: 'manager',
      pendingWait: true,
      autoOff: true,
    }));

    expect(delivered).toContain('[Message from orchestrator]\nReview the open task and continue.\n\n--- HEARTBEAT NOTICE ---');
    expect(delivered).toContain('This message was sent automatically by your heartbeat, not typed just now by your manager.');
    expect(delivered).toContain('It fires every 15 minutes; it was set at Nov 24, 2026, 12:00 PM PST by your manager');
    expect(delivered).toContain('switches itself off at Nov 24, 2026, 6:00 PM PST');
    expect(delivered).toContain('sulla chat/set_heartbeat \'{"intervalMinutes":0}\'');
    expect(delivered).toContain('Your agents/wait timer is still pending and will still wake you.');
    expect(delivered).toContain('switched off automatically after 6 hours');
    expect(delivered).toContain('turn it back on with sulla chat/set_heartbeat');
  });
});

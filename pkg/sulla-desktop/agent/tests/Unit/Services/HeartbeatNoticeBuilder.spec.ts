// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

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
    }));

    expect(delivered).toContain('[Message from orchestrator]\nReview the open task and continue.\n\n--- HEARTBEAT NOTICE ---');
    expect(delivered).toContain('This message was sent automatically by your heartbeat, not typed just now by your manager.');
    expect(delivered).toContain('It fires every 15 minutes; it was set at Nov 24, 2026, 12:00 PM PST by your manager');
    expect(delivered).toContain('switches itself off at Nov 24, 2026, 6:00 PM PST');
    expect(delivered).toContain('sulla chat/set_heartbeat \'{"intervalMinutes":0}\'');
    expect(delivered).toContain('Your agents/wait timer is still pending and will still wake you.');
    expect(delivered).not.toContain('switched off automatically');
  });

  it('distinguishes agent-set and human-set final heartbeat instructions', () => {
    // risk: a final system beat can contradict who owns the decision to restart an automatic timer.
    const builder = new HeartbeatNoticeBuilder('America/Los_Angeles');
    const common = {
      message: 'Continue.', intervalMinutes: 5, startedAt: Date.UTC(2026, 10, 24, 20, 0),
      expiresAt: Date.UTC(2026, 10, 25, 2, 0), autoOff: true,
    };
    const agentNotice = builder.buildMessage({ ...common, setBy: 'agent' });
    const humanNotice = builder.buildMessage({ ...common, setBy: 'human' });

    expect(agentNotice).toContain('switched off automatically after 6 hours');
    expect(agentNotice).toContain(`Turn it back on if the work is still open: sulla chat/set_heartbeat '{"intervalMinutes":5,"message":"..."}'.`);
    expect(agentNotice).not.toContain('The human set this heartbeat.');
    // The heartbeat is already off, so the final beat must not tell the agent to turn it off.
    expect(agentNotice).not.toContain('Turn it off as soon as');
    expect(humanNotice).toContain('The human set this heartbeat. Leave it off unless they ask you to turn it back on.');
    expect(humanNotice).not.toContain('Turn it back on if the work is still open:');
  });
});

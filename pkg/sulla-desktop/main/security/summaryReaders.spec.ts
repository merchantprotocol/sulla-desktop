// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
import type { DecisionRecord } from '@pkg/shared/decisions';
import type { AgentToolActivityRepository } from '@pkg/agent/database/repositories/AgentToolActivityRepository';
import { AgentActionsReader, PendingUseCaseApprovalsReader, SecurityRulesReader, ThreatDailyCountersReader } from './summaryReaders';

const decision = (id: string, status: string, payload: Record<string, unknown>, expiresAt = Date.now() + 60_000) => ({
  id, kind: 'approval', status, payload, expiresAt,
}) as unknown as DecisionRecord;

describe('Security summary readers', () => {
  it('counts only live Files publish approvals shown in Decide', async() => {
    const reader = new PendingUseCaseApprovalsReader(async() => [
      decision('publish', 'pending', { filesPublishRequestId: 'request-1' }),
      decision('deferred', 'deferred', { filesPublishRequestId: 'request-2' }),
      decision('expired', 'pending', { filesPublishRequestId: 'request-3' }, Date.now() - 1),
      decision('tool', 'pending', {}),
    ]);
    expect(await reader.read()).toEqual({ pending: 2 });
    expect(await new PendingUseCaseApprovalsReader(async() => { throw new Error('Files inbox unavailable') }).read()).toBeNull();
  });

  it('maps active Security Conscience rules to id and title and fails closed', async() => {
    const reader = new SecurityRulesReader(async() => [{ id: 'r-1', title: 'Ask before external email' }]);
    expect(await reader.read()).toEqual([{ id: 'r-1', title: 'Ask before external email' }]);
    expect(await new SecurityRulesReader(async() => { throw new Error('database unavailable') }).read()).toBeNull();
  });

  it('maps recent persisted tool actions without copying message content', async() => {
    const recentToolActions = vi.fn(async() => [{ at: '2026-11-18T10:00:00.000Z', actor: 'research-agent', action: 'files/read', target: 'files/read' }]);
    expect(await new AgentActionsReader({ recentToolActions } as unknown as AgentToolActivityRepository).read()).toEqual([{ at: '2026-11-18T10:00:00.000Z', actor: 'research-agent', action: 'files/read', target: 'files/read' }]);
    expect(recentToolActions).toHaveBeenCalledWith(10);
    expect(await new AgentActionsReader({ recentToolActions: async() => { throw new Error('database unavailable') } } as unknown as AgentToolActivityRepository).read()).toBeNull();
  });

  it('returns validated daily totals and null when counters are absent or invalid', async() => {
    expect(await new ThreatDailyCountersReader(async() => ({ scannedToday: 12, blockedToday: 2 })).read()).toEqual({ scannedToday: 12, blockedToday: 2 });
    expect(await new ThreatDailyCountersReader(async() => null).read()).toBeNull();
    expect(await new ThreatDailyCountersReader(async() => ({ scannedToday: -1, blockedToday: 0 })).read()).toBeNull();
    expect(await new ThreatDailyCountersReader(async() => { throw new Error('old proxy image') }).read()).toBeNull();
  });
});

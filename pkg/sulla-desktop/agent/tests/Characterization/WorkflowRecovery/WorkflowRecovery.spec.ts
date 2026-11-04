// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { beforeEach, describe, expect, it, vi } from 'vitest';

const notificationCreate = vi.fn(async() => undefined);
const findStaleExecutions = vi.fn(async() => [] as any[]);
const findSuspended = vi.fn(async() => [] as any[]);
const recover = vi.fn(async() => null as any);
const suspendAllRunning = vi.fn(async() => [] as string[]);
const nextLeaseExpiry = vi.fn(async() => null as Date | null);

vi.mock('../../../database/models/WorkflowExecutionModel', () => ({
  WorkflowExecutionModel: {
    findStaleExecutions,
    findSuspended,
    recover,
    suspendAllRunning,
    nextLeaseExpiry,
  },
}));

vi.mock('../../../../main/chromeApi/ChromeApiService', () => ({
  getChromeApi: () => ({ notifications: { create: notificationCreate } }),
}));

import {
  getPendingSuspended,
  gracefulShutdown,
  recoverOnBoot,
} from '../../../workflow/WorkflowRecoveryService';

const row = (attributes: Record<string, unknown>) => ({ attributes });

describe('workflow recovery legacy behavior', () => {
  beforeEach(() => {
    notificationCreate.mockClear();
    findStaleExecutions.mockReset().mockResolvedValue([]);
    findSuspended.mockReset().mockResolvedValue([]);
    recover.mockReset().mockResolvedValue(null);
    suspendAllRunning.mockReset().mockResolvedValue([]);
    nextLeaseExpiry.mockReset().mockResolvedValue(null);
    getPendingSuspended();
  });

  it('claims stale leases and exposes manual recoveries once through the destructive read', async() => {
    // risk: an interrupted manual workflow disappears or is surfaced with corrupt identity data
    findStaleExecutions.mockResolvedValue([row({ execution_id: 'stale-1' })]);
    recover.mockResolvedValue({
      execution: row({
        execution_id: 'stale-1', workflow_id: 'workflow-1', workflow_name: 'Review',
        workflow_slug: 'review', started_at: new Date('2026-11-03T08:00:00.000Z'), auto_restart: false,
      }),
    });

    await recoverOnBoot();

    expect(recover).toHaveBeenCalledWith('stale-1');
    expect(getPendingSuspended()).toEqual([{
      executionId: 'stale-1', workflowId: 'workflow-1', workflowName: 'Review',
      workflowSlug: 'review', startedAt: '2026-11-03T08:00:00.000Z', autoRestart: false,
    }]);
    expect(getPendingSuspended()).toEqual([]);
  });

  it('defaults legacy suspended rows to auto restart and keeps opt-out rows pending', async() => {
    // risk: legacy rows change restart policy while crossing the compatibility boundary
    findSuspended.mockResolvedValue([
      row({ execution_id: 'auto-1', workflow_id: 'workflow-a', started_at: '2026-11-03T09:00:00.000Z' }),
      row({ execution_id: 'manual-1', workflow_id: 'workflow-m', workflow_name: '', workflow_slug: '', started_at: 'yesterday', auto_restart: false }),
    ]);

    await recoverOnBoot();

    expect(getPendingSuspended()).toEqual([{
      executionId: 'manual-1', workflowId: 'workflow-m', workflowName: 'workflow-m',
      workflowSlug: 'workflow-m', startedAt: 'yesterday', autoRestart: false,
    }]);
  });

  it('notifies a manual execution only once across repeated recovery passes', async() => {
    // risk: every lease scan repeatedly interrupts the user for the same paused workflow
    findSuspended.mockResolvedValue([
      row({ execution_id: 'notify-once', workflow_id: 'workflow-n', workflow_name: 'Notify once', started_at: 'now', auto_restart: false }),
    ]);

    await recoverOnBoot();
    await recoverOnBoot();

    expect(notificationCreate).toHaveBeenCalledTimes(1);
    expect(notificationCreate).toHaveBeenCalledWith('workflow-paused-notify-once', expect.objectContaining({ title: 'Workflow paused: Notify once' }));
  });

  it('suspends all running executions during graceful shutdown', async() => {
    // risk: shutdown closes the database before in-flight workflow state is made recoverable
    suspendAllRunning.mockResolvedValue(['run-1', 'run-2']);

    await gracefulShutdown();

    expect(suspendAllRunning).toHaveBeenCalledOnce();
  });
});

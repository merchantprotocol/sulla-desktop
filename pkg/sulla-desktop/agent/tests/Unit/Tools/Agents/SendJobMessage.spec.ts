// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  targetsForJob: vi.fn(async() => [{ jobId: 'parent-job', taskIndex: 0, jobStatus: 'running', taskStatus: 'parked', threadId: 'parent-thread' }]),
  queueMessage: vi.fn(async() => ({ id: 'queued-message' })),
  markMessagesDelivered: vi.fn(async() => undefined),
  wakeParkedAgent: vi.fn(async() => true),
  cancel: vi.fn(async() => undefined),
  job: { visibility: 'hidden', parentChannel: 'sulla-desktop', tasks: [{ agentId: 'manager' }] },
}));

vi.mock('../../../../database/models/AgentJobMessagingModel', () => ({ AgentJobMessagingModel: {
  targetsForJob: runtime.targetsForJob,
  queueMessage: runtime.queueMessage,
  markMessagesDelivered: runtime.markMessagesDelivered,
} }));
vi.mock('../../../../app/Providers/AgentJobServiceProvider', () => ({ agentJobProvider: { jobs: { job: vi.fn(async() => runtime.job) }, reviewItems: {} } }));
vi.mock('../../../../tools/agents/jobRegistry', () => ({ getJob: vi.fn(async() => runtime.job) }));
vi.mock('../../../../services/AgentWaitServices', () => ({ agentWaitProvider: { cancel: runtime.cancel } }));
vi.mock('../../../../services/BackendGraphWebSocketService', () => ({ getBackendGraphWebSocketService: () => ({ wakeParkedAgent: runtime.wakeParkedAgent }) }));
vi.mock('../../../../utils/steerChannel', () => ({ injectSteer: vi.fn() }));
vi.mock('../../../../tools/base', () => ({ BaseTool: class {} }));
vi.mock('../../../../app/Services/PendingReturnedTaskMessage', () => ({ PendingReturnedTaskMessage: class {} }));

import { sendJobMessage } from '../../../../tools/agents/send_job_message';

describe('sendJobMessage', () => {
  it('returns after durable queueing without awaiting the parked parent turn', async() => {
    // risk: liveness — a question delivery must not wait for the parent graph turn it just woke.
    let finishTurn!: (value: boolean) => void;
    const parentTurn = new Promise<boolean>(resolve => { finishTurn = resolve });
    runtime.wakeParkedAgent.mockReturnValue(parentTurn);

    const sending = sendJobMessage({ jobId: 'parent-job', taskIndex: 0, message: '[Decision from child] Choose?', waitForWake: false });
    await vi.waitFor(() => expect(runtime.wakeParkedAgent).toHaveBeenCalledOnce());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const returnedBeforeTurnFinished = await Promise.race([
      sending.then(() => true),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 250) }),
    ]);
    if (timer) clearTimeout(timer);
    finishTurn(true);
    const response = await sending;

    expect(returnedBeforeTurnFinished).toBe(true);
    expect(runtime.queueMessage).toHaveBeenCalledOnce();
    expect(runtime.wakeParkedAgent).toHaveBeenCalledWith('sulla-desktop', 'parent-thread', expect.any(String), 'manager', expect.objectContaining({ jobMessageId: 'queued-message' }));
    expect(JSON.parse(response.responseString)).toMatchObject({ targetedTasks: [0], queuedForNextBoundary: 1 });
  });
});

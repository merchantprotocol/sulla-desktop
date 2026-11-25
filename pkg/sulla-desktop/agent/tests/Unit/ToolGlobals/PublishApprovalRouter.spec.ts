// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { PublishApprovalRouter } from '../../../tools/files/PublishApprovalRouter';

import type { AgentJobTaskTarget } from '../../../database/models/AgentJobMessagingModel';

class JobAncestry {
  private readonly tasks = new Map<string, AgentJobTaskTarget>();
  add(threadId: string, parentThreadId: string, extra: Partial<AgentJobTaskTarget> = {}): this {
    this.tasks.set(threadId, { jobId: `job-${ threadId }`, taskIndex: 0, jobStatus: 'running', taskStatus: 'running', threadId, parentThreadId, ...extra });
    return this;
  }
  taskForThread = async(threadId: string) => this.tasks.get(threadId) ?? null;
}

describe('PublishApprovalRouter', () => {
  it('shows the card in the top visible chat above a hidden asker, and in the asker\'s own chat when it has no parent', async() => {
    // risk: approval routing — a hidden child has no tab, so its card must climb persisted ancestry and never follow tool input.
    const ancestry = new JobAncestry()
      .add('grandchild', 'child', { parentChannel: 'child-channel' })
      .add('child', 'root', { parentChannel: 'root-channel' });
    const router = new PublishApprovalRouter(ancestry);

    await expect(router.cardTarget({ conversationId: 'grandchild', channel: 'worker-channel' }))
      .resolves.toEqual({ kind: 'ancestor_chat', channel: 'root-channel', threadId: 'root' });
    await expect(router.cardTarget({ conversationId: 'root', channel: 'root-channel' })).resolves.toEqual({ kind: 'requester_chat' });
  });

  it('stops on an ancestry loop instead of walking forever', async() => {
    const router = new PublishApprovalRouter(new JobAncestry().add('a', 'b').add('b', 'a'));

    await expect(router.cardTarget({ conversationId: 'a', channel: 'c' })).resolves.toEqual({ kind: 'ancestor_chat', channel: 'c', threadId: 'b' });
  });

  it('sends the outcome to the asking job task, or to the asking chat when no task asked', async() => {
    // risk: agent continuity — the outcome follows the requester stored on the decision, not whoever happens to be listening.
    const router = new PublishApprovalRouter(new JobAncestry());
    const record = { conversationId: 'child', channel: 'root-channel' };

    await expect(router.outcomeTarget({ ...record, requestedBy: { agentId: 'default agent', jobId: 'job-1', taskIndex: 0 } }))
      .resolves.toEqual({ kind: 'job_task', jobId: 'job-1', taskIndex: 0 });
    await expect(router.outcomeTarget(record)).resolves.toEqual({ kind: 'chat', channel: 'root-channel', threadId: 'child' });
  });

  it('names the requester from its task and reports none for a chat the human talks to directly', async() => {
    const router = new PublishApprovalRouter(new JobAncestry().add('child', 'root', { agentId: 'codex-luna-worker', label: 'Publish the agent', taskIndex: 2 }));

    await expect(router.requester('child')).resolves.toEqual({ agentId: 'codex-luna-worker', label: 'Publish the agent', jobId: 'job-child', taskIndex: 2 });
    await expect(router.requester('root')).resolves.toBeUndefined();
  });

  it('does not store a task label as an agent id when the task has no agent id', async() => {
    // risk: user clarity — the requester card shows a task label once without persisting it as a second identity.
    const router = new PublishApprovalRouter(new JobAncestry().add('child', 'root', { label: 'Publish the agent', taskIndex: 2 }));

    await expect(router.requester('child')).resolves.toEqual({ label: 'Publish the agent', jobId: 'job-child', taskIndex: 2 });
  });
});

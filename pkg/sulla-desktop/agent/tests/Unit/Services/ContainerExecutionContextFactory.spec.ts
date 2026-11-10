// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { ContainerExecutionContextFactory, type AgentContainerRuntimeBinding } from '../../../services/AgentContainerRuntimeRegistry';

const binding: AgentContainerRuntimeBinding = {
  podId: 'pod-a', subject: 'user-a', orgId: 'org-a', agentId: 'worker-a', jobId: 'job-a',
  threadId: 'thread-a', deviceId: 'device-a', workspacePath: '/workspace/a',
};

describe('ContainerExecutionContextFactory', () => {
  it('binds the MCP capability to the explicit job and agent outside runtime ALS', () => {
    // risk: cross-job credential scope
    const factory = new ContainerExecutionContextFactory(() => undefined);
    const context = factory.create({ metadata: { allowedToolNames: ['github.git'] } } as any, 60_000, binding);
    expect(context).toMatchObject({ pod_id: 'pod-a', job_id: 'job-a', agent_id: 'worker-a', sub: 'user-a', scopes: ['github.git'] });
  });

  it('returns no capability when neither explicit binding nor runtime scope exists', () => {
    // risk: cross-job credential scope
    const factory = new ContainerExecutionContextFactory(() => undefined);
    expect(factory.create({ metadata: {} } as any, 60_000)).toBeUndefined();
  });
});

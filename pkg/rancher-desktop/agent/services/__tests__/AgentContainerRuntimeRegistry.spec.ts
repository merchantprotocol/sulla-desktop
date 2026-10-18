import {
  containerRuntimeForExecution,
  registerAgentContainerRuntime,
} from '../AgentContainerRuntimeRegistry';

import type { ToolExecutionContext } from '../../tools/executionContext';

const context = (overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext => ({
  v:          1,
  iss:        'test',
  aud:        'sulla-tools',
  sub:        'owner',
  org_id:     'org',
  agent_id:   'agent',
  pod_id:     'sulla-agent-job-0',
  thread_id:  'thread',
  job_id:     'job',
  device_id:  'device',
  scopes:     ['*'],
  iat:        1,
  exp:        2,
  jti:        'jti',
  request_id: 'request',
  ...overrides,
});

describe('containerRuntimeForExecution', () => {
  it('preserves ordinary agent-local relay execution when there is no pod claim', () => {
    expect(containerRuntimeForExecution(context({ pod_id: undefined }), 'agent-local')).toBeUndefined();
  });

  it('returns only the exact live container binding and rejects mismatches', () => {
    const binding = {
      podId: 'sulla-agent-job-0', subject: 'owner', orgId: 'org', agentId: 'agent',
      jobId: 'job', threadId: 'thread', deviceId: 'device', workspacePath: '/workspace',
    };
    const unregister = registerAgentContainerRuntime(binding);

    try {
      expect(containerRuntimeForExecution(context(), 'agent-local')).toBe(binding);
      expect(() => containerRuntimeForExecution(context({ job_id: 'other-job' }), 'agent-local')).toThrow(/not bound/);
      expect(containerRuntimeForExecution(context(), 'controller')).toBeUndefined();
    } finally {
      unregister();
    }
  });
});

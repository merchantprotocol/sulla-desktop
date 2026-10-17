import { AsyncLocalStorage } from 'node:async_hooks';

import type { ToolExecutionContext } from '../tools/executionContext';

export interface AgentContainerRuntimeBinding {
  podId:         string;
  subject:       string;
  orgId?:        string;
  agentId?:      string;
  jobId:         string;
  threadId?:     string;
  deviceId:      string;
  workspacePath: string;
}

const bindings = new Map<string, AgentContainerRuntimeBinding>();
const activeRuntime = new AsyncLocalStorage<AgentContainerRuntimeBinding>();

export function withAgentContainerRuntime<T>(binding: AgentContainerRuntimeBinding, action: () => T): T {
  return activeRuntime.run(binding, action);
}

export function currentAgentContainerRuntime(): AgentContainerRuntimeBinding | undefined {
  return activeRuntime.getStore();
}

export function registerAgentContainerRuntime(binding: AgentContainerRuntimeBinding): () => void {
  bindings.set(binding.podId, binding);

  return () => {
    if (bindings.get(binding.podId) === binding) bindings.delete(binding.podId);
  };
}

export function requireAgentContainerRuntime(ctx: ToolExecutionContext): AgentContainerRuntimeBinding {
  const podId = ctx.pod_id ?? '';
  const binding = bindings.get(podId);

  if (!binding) throw new Error('Agent tool context is not bound to a live container');
  if (ctx.sub !== binding.subject ||
      ctx.org_id !== binding.orgId ||
      ctx.agent_id !== binding.agentId ||
      ctx.job_id !== binding.jobId ||
      ctx.thread_id !== binding.threadId ||
      ctx.device_id !== binding.deviceId) {
    throw new Error('Agent tool context is not bound to this live container job');
  }

  return binding;
}

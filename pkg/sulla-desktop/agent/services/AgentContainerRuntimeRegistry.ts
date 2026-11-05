// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { ToolExecutionContext } from '../tools/executionContext';
import type { ToolExecutionTarget } from '../tools/executionTargets';

export interface AgentContainerRuntimeBinding { podId: string; subject: string; orgId?: string; agentId?: string; jobId: string; threadId?: string; deviceId: string; workspacePath: string; }
export interface AgentContainerRuntimeSupervisor { liveBindings(): Promise<AgentContainerRuntimeBinding[]>; }

/** Injectible owner of container bindings and fail-closed boot rehydration. */
export class AgentContainerRuntimeRegistry {
  private readonly bindings = new Map<string, AgentContainerRuntimeBinding>();
  private readonly activeRuntime = new AsyncLocalStorage<AgentContainerRuntimeBinding>();
  private rehydrated: Promise<void> = Promise.resolve();
  private rebindPending = true;
  constructor(private readonly supervisor?: AgentContainerRuntimeSupervisor) {}
  rehydrate(): Promise<void> {
    if (!this.supervisor) throw new Error('Agent container runtime supervisor is not configured');
    this.rebindPending = true;
    this.rehydrated = this.supervisor.liveBindings().then(bindings => {
      // Merge inventory with registrations created while Docker inspection was in flight.
      for (const binding of bindings) if (!this.bindings.has(binding.podId)) this.bindings.set(binding.podId, binding);
      this.rebindPending = false;
    });
    return this.rehydrated;
  }
  ready(): Promise<void> { return this.rehydrated; }
  /** Tri-state liveness: undefined protects tasks while restart rebind is pending. */
  probe(jobId?: string, threadId?: string): boolean | undefined {
    if (this.has(jobId, threadId)) return true;
    return this.rebindPending ? undefined : false;
  }
  withRuntime<T>(binding: AgentContainerRuntimeBinding, action: () => T): T { return this.activeRuntime.run(binding, action); }
  has(jobId?: string, threadId?: string): boolean { return Array.from(this.bindings.values()).some(binding => (!jobId || binding.jobId === jobId) && (!threadId || binding.threadId === threadId)); }
  current(): AgentContainerRuntimeBinding | undefined { return this.activeRuntime.getStore(); }
  register(binding: AgentContainerRuntimeBinding): () => void { this.bindings.set(binding.podId, binding); return () => { if (this.bindings.get(binding.podId) === binding) this.bindings.delete(binding.podId); }; }
  require(ctx: ToolExecutionContext): AgentContainerRuntimeBinding {
    const binding = this.bindings.get(ctx.pod_id ?? ''); if (!binding) throw new Error('Agent tool context is not bound to a live container');
    if (ctx.sub !== binding.subject || ctx.org_id !== binding.orgId || ctx.agent_id !== binding.agentId || ctx.job_id !== binding.jobId || ctx.thread_id !== binding.threadId || ctx.device_id !== binding.deviceId) throw new Error('Agent tool context is not bound to this live container job');
    return binding;
  }
  forExecution(ctx: ToolExecutionContext, target: ToolExecutionTarget | undefined): AgentContainerRuntimeBinding | undefined { return target === 'agent-local' && ctx.pod_id ? this.require(ctx) : undefined; }
}

class DeferredAgentContainerRuntimeSupervisor implements AgentContainerRuntimeSupervisor {
  private source?: AgentContainerRuntimeSupervisor;
  configure(source: AgentContainerRuntimeSupervisor): void { this.source = source }
  liveBindings(): Promise<AgentContainerRuntimeBinding[]> {
    if (!this.source) throw new Error('Agent container runtime supervisor is not configured');
    return this.source.liveBindings();
  }
}
const deferredSupervisor = new DeferredAgentContainerRuntimeSupervisor();
export const agentContainerRuntimeRegistry = new AgentContainerRuntimeRegistry(deferredSupervisor);
export const configureAgentContainerRuntimeSupervisor = (supervisor: AgentContainerRuntimeSupervisor) => deferredSupervisor.configure(supervisor);
export const rehydrateAgentContainerRuntimes = () => agentContainerRuntimeRegistry.rehydrate();
export const awaitAgentContainerRuntimeRehydration = () => agentContainerRuntimeRegistry.ready();
export const withAgentContainerRuntime = <T>(binding: AgentContainerRuntimeBinding, action: () => T) => agentContainerRuntimeRegistry.withRuntime(binding, action);
export const hasAgentContainerRuntime = (jobId?: string, threadId?: string) => agentContainerRuntimeRegistry.has(jobId, threadId);
export const probeAgentContainerRuntime = (jobId?: string, threadId?: string) => agentContainerRuntimeRegistry.probe(jobId, threadId);
export const currentAgentContainerRuntime = () => agentContainerRuntimeRegistry.current();
export const registerAgentContainerRuntime = (binding: AgentContainerRuntimeBinding) => agentContainerRuntimeRegistry.register(binding);
export const requireAgentContainerRuntime = (ctx: ToolExecutionContext) => agentContainerRuntimeRegistry.require(ctx);
export const containerRuntimeForExecution = (ctx: ToolExecutionContext, target: ToolExecutionTarget | undefined) => agentContainerRuntimeRegistry.forExecution(ctx, target);

// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { ContainerSessionLeases } from './ContainerSessionLeases';
import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import type { ToolExecutionContext } from '../tools/executionContext';
import type { ToolExecutionTarget } from '../tools/executionTargets';
import type { BaseThreadState } from '../nodes/Graph';

/** Builds a session's capability from its explicit container binding, falling back only to ALS. */
export class ContainerExecutionContextFactory {
  constructor(private readonly runtime: () => AgentContainerRuntimeBinding | undefined = () => currentAgentContainerRuntime()) {}
  create(state: BaseThreadState, ttlMs: number, binding?: AgentContainerRuntimeBinding): ToolExecutionContext | undefined {
    const runtime = binding ?? this.runtime();
    if (!runtime) return undefined;
    const allowed = (state.metadata as { allowedToolNames?: string[] }).allowedToolNames ?? [];
    const now = Math.floor(Date.now() / 1000);
    return {
      v: 1, iss: 'sulla-desktop', aud: 'sulla-tools', sub: runtime.subject,
      org_id: runtime.orgId, agent_id: runtime.agentId, pod_id: runtime.podId,
      thread_id: runtime.threadId, job_id: runtime.jobId, task_index: runtime.taskIndex, device_id: runtime.deviceId,
      scopes: allowed.length === 0 || allowed.includes('exec') ? ['*'] : [...allowed],
      iat: now, exp: now + Math.ceil(ttlMs / 1000), jti: crypto.randomUUID(), request_id: crypto.randomUUID(),
    };
  }
}

export interface AgentContainerRuntimeBinding {
  podId: string;
  subject: string;
  orgId?: string;
  agentId?: string;
  jobId: string;
  taskIndex?: number;
  threadId?: string;
  deviceId: string;
  workspacePath: string;
  /** Inventory protects files from cleanup but has no live Desktop-owned capability bridge. */
  origin?: 'desktop' | 'inventory';
}
export interface AgentContainerRuntimeSupervisor {
  liveBindings(): Promise<AgentContainerRuntimeBinding[]>;
  recoveredLeases?(binding: AgentContainerRuntimeBinding, caller?: ToolExecutionContext): ContainerSessionLeases | undefined;
}

/** Injectible owner of container bindings and fail-closed boot rehydration. */
export class AgentContainerRuntimeRegistry {
  private readonly bindings = new Map<string, AgentContainerRuntimeBinding>();
  private readonly invalidationListeners = new WeakMap<AgentContainerRuntimeBinding, Set<() => void>>();
  // Keep signing authority out of serializable runtime bindings and snapshots.
  private readonly leases = new WeakMap<AgentContainerRuntimeBinding, ContainerSessionLeases>();
  // Only recovered dispatches need a caller-bounded issuer. Ordinary workers never request it.
  private readonly recovered = new WeakSet<AgentContainerRuntimeBinding>();
  private readonly dispatches = new WeakMap<AgentContainerRuntimeBinding, { binding: AgentContainerRuntimeBinding; caller: ToolExecutionContext }>();
  sessionLeases(binding: AgentContainerRuntimeBinding) {
    const dispatch = this.dispatches.get(binding);
    if (dispatch) {
      if (this.bindings.get(dispatch.binding.podId) !== dispatch.binding) throw new Error('Recovered container binding changed');
      return this.supervisor?.recoveredLeases?.(dispatch.binding, dispatch.caller);
    }
    return this.leases.get(binding) ?? this.supervisor?.recoveredLeases?.(binding);
  }

  /** A displaced binding can still have an issuer until its cleanup runs. It no longer owns this pod. */
  launcherTransportVersion(binding: AgentContainerRuntimeBinding, sessionId: string): '1' | '2' | undefined {
    const live = this.bindings.get(binding.podId);
    const leases = this.leases.get(binding);
    return live && leases?.ownsLauncher(sessionId) && this.leases.get(live) === leases ? leases.transportVersion : undefined;
  }

  private readonly activeRuntime = new AsyncLocalStorage<AgentContainerRuntimeBinding>();
  private rehydrated: Promise<void> = Promise.resolve();
  private rebindPending = true;
  constructor(private readonly supervisor?: AgentContainerRuntimeSupervisor) {}
  rehydrate(): Promise<void> {
    if (!this.supervisor) throw new Error('Agent container runtime supervisor is not configured');
    this.rebindPending = true;
    this.rehydrated = this.supervisor.liveBindings().then(bindings => {
      // Merge inventory with registrations created while Docker inspection was in flight.
      for (const binding of bindings) if (!this.bindings.has(binding.podId)) {
        this.bindings.set(binding.podId, binding);
        this.recovered.add(binding);
      }
      this.rebindPending = false;
    });
    return this.rehydrated;
  }
  ready(): Promise<void> { return this.rehydrated; }
  /** Tri-state liveness: undefined protects tasks while restart rebind is pending. */
  probe(jobId?: string, threadId?: string, origin?: AgentContainerRuntimeBinding['origin']): boolean | undefined {
    if (this.has(jobId, threadId, origin)) return true;
    return this.rebindPending ? undefined : false;
  }
  /** Immutable cleanup/read-model snapshot; pending rehydration remains fail-closed. */
  snapshot(): { ready: boolean; bindings: AgentContainerRuntimeBinding[] } {
    return { ready: !this.rebindPending, bindings: Array.from(this.bindings.values()).map(binding => ({ ...binding })) };
  }

  withRuntime<T>(binding: AgentContainerRuntimeBinding, action: () => T): T { return this.activeRuntime.run(binding, action); }
  has(jobId?: string, threadId?: string, origin?: AgentContainerRuntimeBinding['origin']): boolean {
    return Array.from(this.bindings.values()).some(binding => (!jobId || binding.jobId === jobId) &&
      (!threadId || binding.threadId === threadId) && (!origin || (binding.origin ?? 'desktop') === origin));
  }
  current(): AgentContainerRuntimeBinding | undefined { return this.activeRuntime.getStore(); }
  register(binding: AgentContainerRuntimeBinding, leases?: ContainerSessionLeases): () => void {
    const owned = { ...binding, origin: 'desktop' as const };
    const previous = this.bindings.get(owned.podId);
    if (previous) this.invalidate(previous);
    this.bindings.set(owned.podId, owned);
    // The launcher enters its own object; dispatch enters the registered copy. Both resolve the same leases.
    if (leases) { this.leases.set(binding, leases); this.leases.set(owned, leases); }
    return () => {
      this.leases.delete(binding); this.leases.delete(owned);
      if (this.bindings.get(owned.podId) === owned) {
        this.bindings.delete(owned.podId);
        this.invalidate(owned);
      }
    };
  }

  /** Subscribe to replacement or removal of this exact live pod registration. */
  watchInvalidation(binding: AgentContainerRuntimeBinding, listener: () => void): () => void {
    if (this.bindings.get(binding.podId) !== binding) { listener(); return () => {} }
    const listeners = this.invalidationListeners.get(binding) ?? new Set<() => void>();
    listeners.add(listener);
    this.invalidationListeners.set(binding, listeners);
    return () => listeners.delete(listener);
  }

  private invalidate(binding: AgentContainerRuntimeBinding): void {
    const listeners = this.invalidationListeners.get(binding);
    if (!listeners) return;
    this.invalidationListeners.delete(binding);
    for (const listener of listeners) {
      try { listener() } catch { /* A faulty observer cannot block revocation. */ }
    }
  }

  require(ctx: ToolExecutionContext): AgentContainerRuntimeBinding {
    // `reason` is a non-secret code the provider bridge logs when it refuses a request.
    const binding = this.bindings.get(ctx.pod_id ?? ''); if (!binding) throw Object.assign(new Error('Agent tool context is not bound to a live container'), { reason: 'container_not_registered' });
    if (binding.origin === 'inventory') throw Object.assign(new Error('Agent tool context has no live Desktop capability owner'), { reason: 'container_owner_not_rehydrated' });
    if (ctx.sub !== binding.subject || ctx.org_id !== binding.orgId || ctx.agent_id !== binding.agentId || ctx.job_id !== binding.jobId || ctx.thread_id !== binding.threadId || ctx.device_id !== binding.deviceId) throw Object.assign(new Error('Agent tool context is not bound to this live container job'), { reason: 'container_job_mismatch' });
    return binding;
  }
  /** Forwarded agent-local work must enter the caller's registered, verified container; never the shared VM. */
  forForwardedExecution(ctx: ToolExecutionContext | undefined, target: ToolExecutionTarget | undefined): AgentContainerRuntimeBinding | undefined {
    if (target !== 'agent-local') return undefined;
    if (!ctx?.pod_id) throw Object.assign(new Error('Agent-local tools run only inside the calling agent container'), { reason: 'container_runtime_required' });
    return this.forExecution(ctx, target);
  }
  forExecution(ctx: ToolExecutionContext, target: ToolExecutionTarget | undefined): AgentContainerRuntimeBinding | undefined {
    if (target !== 'agent-local' || !ctx.pod_id) return undefined;
    const binding = this.require(ctx);
    if (!this.recovered.has(binding)) return binding;
    if (ctx.task_index !== binding.taskIndex || !Number.isFinite(ctx.exp) || ctx.exp <= Math.floor(Date.now() / 1000)) {
      throw new Error('Invalid identity or expiry for recovered container');
    }
    // Never share a caller-bounded authority with a different concurrent dispatch.
    const dispatch = { ...binding };
    this.dispatches.set(dispatch, { binding, caller: structuredClone(ctx) });
    return dispatch;
  }
}

class DeferredAgentContainerRuntimeSupervisor implements AgentContainerRuntimeSupervisor {
  private source?: AgentContainerRuntimeSupervisor;
  recoveredLeases(binding: AgentContainerRuntimeBinding, caller?: ToolExecutionContext) {
    return this.source?.recoveredLeases?.(binding, caller);
  }
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
export const probeAgentContainerRuntime = (jobId?: string, threadId?: string, origin?: AgentContainerRuntimeBinding['origin']) => agentContainerRuntimeRegistry.probe(jobId, threadId, origin);
export const snapshotAgentContainerRuntimes = () => agentContainerRuntimeRegistry.snapshot();
export const currentAgentContainerRuntime = () => agentContainerRuntimeRegistry.current();
export const registerAgentContainerRuntime = (binding: AgentContainerRuntimeBinding, leases?: ContainerSessionLeases) => agentContainerRuntimeRegistry.register(binding, leases);
export const requireAgentContainerRuntime = (ctx: ToolExecutionContext) => agentContainerRuntimeRegistry.require(ctx);
export const containerRuntimeForExecution = (ctx: ToolExecutionContext, target: ToolExecutionTarget | undefined) => agentContainerRuntimeRegistry.forExecution(ctx, target);
export const containerRuntimeForForwardedExecution = (ctx: ToolExecutionContext | undefined, target: ToolExecutionTarget | undefined) => agentContainerRuntimeRegistry.forForwardedExecution(ctx, target);

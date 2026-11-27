// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { sessionAllowsTool } from './toolSessionPolicy';

import { ClerkError, type ClerkCaller } from '@pkg/agent/integrations/clerk/ClerkClient';
import { CLERK_ACCOUNT, CLERK_DEADLINE_MS } from '@pkg/agent/integrations/clerk/ClerkEndpoints';
import type { AgentAwarenessPolicy } from '@pkg/agent/services/AgentAwarenessPolicy';
import { agentContainerRuntimeRegistry, type AgentContainerRuntimeRegistry, type AgentContainerRuntimeBinding } from '@pkg/agent/services/AgentContainerRuntimeRegistry';
import type { ClerkWorker } from '@pkg/agent/tools/clerk/ClerkWorker';
import type { ToolExecutionContext } from '@pkg/agent/tools/executionContext';
import { scopeAllows } from '@pkg/runtime/capabilityToken';

import type { ToolSession } from './mcpToolSessions';

export const CLERK_CONTAINER_DENIAL = 'clerk_container_isolation_unavailable';
const CLERK_TRANSPORT_V2_REQUIRED = 'Clerk requires the current agent image (transport v2). Relaunch this agent after the image is available.';

interface ToolSessionLookup {
  getToolSession(token: string): ToolSession | null;
  watchToolSessionInvalidation?(id: string, generation: string, listener: () => void): () => void;
}

interface LocalContextIssuer {
  issueLocalBrokerContext(input: {
    agentId:         string;
    podId:           string;
    jobId?:          string;
    orgId?:          string;
    credentialScope: NonNullable<ToolExecutionContext['credential_scope']>;
    threadId:        string;
    signal:          AbortSignal;
  }): Promise<ToolExecutionContext>;
}

interface ForwardedSessionBinding {
  session:    ToolSession;
  metadata:   Record<string, unknown>;
  runtime:    AgentContainerRuntimeBinding;
  subject:    string;
  orgId?:     string;
  taskIndex:  number;
  generation: string;
  expiresAt:  number;
}

/** Resolves Clerk callers only from the authenticated, live tool-session bearer. */
export class ClerkToolSessionResolver {
  constructor(
    private readonly sessions: ToolSessionLookup,
    private readonly localContexts: LocalContextIssuer,
    private readonly installationToken: () => string | null,
    private readonly awarenessPolicy: AgentAwarenessPolicy,
    private readonly now: () => number = Date.now,
    private readonly runtimeRegistry: Pick<AgentContainerRuntimeRegistry, 'require' | 'watchInvalidation'> = agentContainerRuntimeRegistry,
  ) {}

  async resolve(
    request: { headers: Record<string, string | string[] | undefined> },
    name: string,
    signal: AbortSignal,
  ): Promise<ClerkCaller> {
    const match = /^Bearer\s+(\S+)$/i.exec(String(request.headers.authorization ?? '').trim());
    const bearer = match?.[1];
    if (!bearer) throw new ClerkError(401, 'A verified Clerk tool bearer is required.');
    const suppliedSession = request.headers['x-sulla-tool-session'];
    if (suppliedSession !== undefined &&
        (typeof suppliedSession !== 'string' || !suppliedSession.trim() || suppliedSession.trim() !== bearer)) {
      throw new ClerkError(403, 'The Clerk tool-session header must match the authenticated bearer.');
    }
    const installationToken = this.installationToken();
    if (installationToken && bearer === installationToken) {
      throw new ClerkError(403, 'Clerk requires a verified agent tool session.');
    }
    return this.resolveSession(bearer, name, signal);
  }

  /** Bind a forwarded Clerk call only to its live Desktop-owned container/session lease. */
  async bindForwarded(worker: ClerkWorker, name: string, sessionId: unknown, forwarded: ToolExecutionContext | undefined, signal: AbortSignal): Promise<void> {
    const startedAt = this.now();
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(CLERK_DEADLINE_MS)]);
    const resolve = () => this.resolveForwardedSession(sessionId, name, forwarded);
    const resolved = resolve();
    const lifetime = this.watchLifecycle(resolved.session, requestSignal, resolved.runtime);
    let execution: ToolExecutionContext;
    try {
      execution = await this.issueForwardedBrokerContext(resolved, lifetime.signal);
    } catch (error) {
      lifetime.dispose();
      throw error;
    }
    if (lifetime.signal.aborted) {
      lifetime.dispose();
      return this.denyForwarded('forwarded Clerk authorization was invalidated before broker admission.');
    }
    const deadlineAt = Math.min(startedAt + CLERK_DEADLINE_MS, resolved.expiresAt, forwarded!.exp * 1_000,
      resolved.session.executionContext!.exp * 1_000);
    if (lifetime.signal.aborted || deadlineAt <= this.now()) {
      lifetime.dispose();
      throw new ClerkError(403, `${ CLERK_CONTAINER_DENIAL }: forwarded Clerk authorization expired.`);
    }
    const boundedSignal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(Math.max(1, deadlineAt - this.now()))]);
    boundedSignal.addEventListener('abort', lifetime.dispose, { once: true });
    const channel = resolved.metadata.wsChannel;
    worker.bindClerkCaller({
      execution,
      conversationId: resolved.runtime.threadId ?? '',
      channel:        typeof channel === 'string' ? channel : undefined,
      toolName:       name,
      deadlineAt,
      signal:         boundedSignal,
      binding:        { taskIndex: resolved.taskIndex, generation: resolved.generation },
      revalidate:     async() => {
        if (boundedSignal.aborted || this.now() >= deadlineAt) {
          throw new ClerkError(403, `${ CLERK_CONTAINER_DENIAL }: forwarded Clerk authorization expired.`);
        }
        const current = resolve();
        return this.issueForwardedBrokerContext(current, boundedSignal);
      },
    });
  }

  /** Resolve the already-authenticated MCP session captured by its handler. */
  resolveSession(sessionId: string, name: string, signal: AbortSignal, expectedState?: ToolSession['state']): Promise<ClerkCaller> {
    const installationToken = this.installationToken();
    if (!sessionId || (installationToken && sessionId === installationToken)) {
      throw new ClerkError(403, 'Clerk requires a verified agent tool session.');
    }
    return this.resolveBearer(sessionId, name, signal, expectedState);
  }

  private async resolveBearer(bearer: string, name: string, signal: AbortSignal, expectedState?: ToolSession['state']): Promise<ClerkCaller> {
    const startedAt = this.now();
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(CLERK_DEADLINE_MS)]);
    let callerSignal = requestSignal;

    const resolveSession = async(pinnedState = expectedState, pinnedGeneration?: string) => {
      const session = this.sessions.getToolSession(bearer);
      if (!session || (pinnedState && session.state !== pinnedState)) throw new ClerkError(403, 'The Clerk tool session is invalid or expired.');
      if (!session.clerkGeneration || (pinnedGeneration && session.clerkGeneration !== pinnedGeneration)) {
        throw new ClerkError(403, 'The Clerk tool session is invalid or expired.');
      }
      const expiresAt = session.expiresAt;
      if (!Number.isFinite(expiresAt) || expiresAt <= this.now()) throw new ClerkError(403, 'The Clerk tool session is invalid or expired.');
      // Check the server's origin on every use, including after approval and rebind.
      if (session.executionContext || session.clerk !== 'local') throw new ClerkError(403, CLERK_CONTAINER_DENIAL);
      const metadata = session.state?.metadata as Record<string, unknown> | undefined;
      const allowed = metadata?.allowedToolNames;
      if (!Array.isArray(allowed) || allowed.length === 0 || !sessionAllowsTool(allowed, name, metadata, this.awarenessPolicy)) {
        throw new ClerkError(403, 'This tool session is not authorized for Clerk.');
      }
      const agentId = String(metadata?.agentId ?? '').trim();
      const threadId = String(metadata?.threadId ?? '').trim();
      if (!agentId || !threadId) throw new ClerkError(403, 'The Clerk tool session is missing trusted agent context.');
      const jobId = this.hostLocalJobId(metadata);
      const orgId = typeof metadata.orgId === 'string' && metadata.orgId.trim() ? metadata.orgId.trim() : undefined;
      const taskIndex = this.hostLocalTaskIndex(metadata);
      const execution = await this.localContexts.issueLocalBrokerContext({
        agentId,
        podId:           'desktop-main',
        jobId,
        orgId,
        credentialScope: { integration_id: 'clerk', account_id: CLERK_ACCOUNT },
        threadId,
        signal:          callerSignal,
      });
      return { execution, metadata, state: session.state, session, expiresAt, clerkGeneration: session.clerkGeneration, taskIndex };
    };

    const resolved = await resolveSession();
    const lifetime = this.watchLifecycle(resolved.session, requestSignal);
    callerSignal = lifetime.signal;
    const channel = resolved.metadata?.wsChannel;
    const deadlineAt = Math.min(startedAt + CLERK_DEADLINE_MS, resolved.execution.exp * 1_000, resolved.expiresAt);
    if (lifetime.signal.aborted || deadlineAt <= this.now()) {
      lifetime.dispose();
      throw new ClerkError(403, 'The Clerk session authorization expired.');
    }
    const boundedSignal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(Math.max(1, deadlineAt - this.now()))]);
    boundedSignal.addEventListener('abort', lifetime.dispose, { once: true });
    return {
      execution:      resolved.execution,
      binding:        { taskIndex: resolved.taskIndex, generation: resolved.clerkGeneration },
      conversationId: String(resolved.metadata?.threadId ?? resolved.execution.thread_id ?? ''),
      channel:        typeof channel === 'string' ? channel : undefined,
      toolName:       name,
      deadlineAt,
      signal:         boundedSignal,
      revalidate:     async() => {
        if (boundedSignal.aborted || this.now() >= deadlineAt) throw new ClerkError(403, 'The Clerk session authorization expired.');
        const current = await resolveSession(resolved.state, resolved.clerkGeneration);
        return current.execution;
      },
    };
  }

  private resolveForwardedSession(sessionId: unknown, name: string, forwarded: ToolExecutionContext | undefined): ForwardedSessionBinding {
    const now = this.now();
    const installationToken = this.installationToken();
    if (!forwarded) this.denyForwarded();
    if (typeof forwarded.tool_session_generation !== 'string' || !forwarded.tool_session_generation.trim()) this.denyTransportV2();
    if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.trim() !== sessionId ||
        (installationToken && sessionId === installationToken) ||
        forwarded.v !== 1 || forwarded.iss !== 'sulla-desktop' || forwarded.aud !== 'sulla-tools' ||
        !Number.isFinite(forwarded.exp) || forwarded.exp * 1_000 <= now ||
        typeof forwarded.task_index !== 'number' || !Number.isSafeInteger(forwarded.task_index) || forwarded.task_index < 0 ||
        typeof forwarded.tool_session_generation !== 'string' || !forwarded.tool_session_generation.trim() ||
        !Array.isArray(forwarded.scopes) || !scopeAllows(forwarded.scopes, 'clerk', name)) {
      this.denyForwarded();
    }

    let runtime: AgentContainerRuntimeBinding;
    try {
      runtime = this.runtimeRegistry.require(forwarded);
    } catch {
      return this.denyForwarded();
    }
    // require() is shared with forwarded agent-local tools. Clerk must also reject
    // rehydrated inventory: only register() creates a Desktop-owned live binding.
    if (runtime.origin !== 'desktop') this.denyForwarded();

    const session = this.sessions.getToolSession(sessionId);
    if (session?.id !== sessionId) this.denyForwarded();
    const sessionContext = session.executionContext;
    if (session.clerk !== 'ordinary' || !sessionContext ||
        !Number.isFinite(session.expiresAt) || session.expiresAt <= now ||
        !Number.isFinite(sessionContext.exp) || sessionContext.exp * 1_000 <= now ||
        sessionContext.jti !== forwarded.tool_session_generation ||
        sessionContext.sub !== forwarded.sub || sessionContext.org_id !== forwarded.org_id ||
        sessionContext.agent_id !== forwarded.agent_id || sessionContext.pod_id !== forwarded.pod_id ||
        sessionContext.job_id !== forwarded.job_id || sessionContext.thread_id !== forwarded.thread_id ||
        sessionContext.task_index !== forwarded.task_index || sessionContext.device_id !== forwarded.device_id ||
        runtime.taskIndex !== forwarded.task_index) {
      this.denyForwarded();
    }

    const metadata = session.state?.metadata as Record<string, unknown> | undefined;
    const allowed = metadata?.allowedToolNames;
    if (!Array.isArray(allowed) || allowed.length === 0 || !sessionAllowsTool(allowed, name, metadata, this.awarenessPolicy)) {
      this.denyForwarded();
    }
    const agentId = String(metadata?.agentId ?? '').trim();
    const threadId = String(metadata?.threadId ?? '').trim();
    if (!agentId || !threadId || agentId !== forwarded.agent_id || threadId !== forwarded.thread_id ||
        !forwarded.pod_id || !forwarded.job_id) {
      this.denyForwarded();
    }
    return {
      session,
      metadata,
      runtime,
      subject:    forwarded.sub,
      orgId:      forwarded.org_id,
      taskIndex:  forwarded.task_index,
      generation: forwarded.tool_session_generation,
      expiresAt:  session.expiresAt,
    };
  }

  private async issueForwardedBrokerContext(binding: ForwardedSessionBinding, signal: AbortSignal): Promise<ToolExecutionContext> {
    const execution = await this.localContexts.issueLocalBrokerContext({
      agentId:         binding.runtime.agentId!,
      podId:           binding.runtime.podId,
      jobId:           binding.runtime.jobId,
      orgId:           binding.orgId,
      credentialScope: { integration_id: 'clerk', account_id: CLERK_ACCOUNT },
      threadId:        binding.runtime.threadId!,
      signal,
    });
    if (execution.sub !== binding.subject || execution.org_id !== binding.orgId) {
      return this.denyForwarded('issued Clerk broker subject or organization does not match the verified forwarded session.');
    }
    if (signal.aborted) return this.denyForwarded('forwarded Clerk authorization was invalidated before broker admission.');
    return { ...execution, task_index: binding.taskIndex, tool_session_generation: binding.generation };
  }

  private denyForwarded(reason = 'forwarded Clerk context must match a live Desktop-owned container session.'): never {
    throw new ClerkError(403, `${ CLERK_CONTAINER_DENIAL }: ${ reason }`);
  }

  private denyTransportV2(): never {
    throw new ClerkError(403, `${ CLERK_CONTAINER_DENIAL }: ${ CLERK_TRANSPORT_V2_REQUIRED }`);
  }

  private hostLocalJobId(metadata: Record<string, unknown>): string | undefined {
    const delegatedJob = typeof metadata.delegatedJobId === 'string' ? metadata.delegatedJobId.trim() : '';
    const workerTask = metadata.workerModelTask && typeof metadata.workerModelTask === 'object'
      ? metadata.workerModelTask as Record<string, unknown>
      : undefined;
    const workerJob = typeof workerTask?.jobId === 'string' ? workerTask.jobId.trim() : '';
    const job = typeof metadata.jobId === 'string' ? metadata.jobId.trim() : '';
    return delegatedJob || workerJob || job || undefined;
  }

  private hostLocalTaskIndex(metadata: Record<string, unknown>): number {
    const workerTask = metadata.workerModelTask && typeof metadata.workerModelTask === 'object'
      ? metadata.workerModelTask as Record<string, unknown>
      : undefined;
    const candidates = [metadata.delegatedTaskIndex, workerTask?.taskIndex, metadata.taskIndex];
    return candidates.find((value): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) ?? 0;
  }

  private watchLifecycle(session: ToolSession, parentSignal: AbortSignal, runtime?: AgentContainerRuntimeBinding): {
    signal:  AbortSignal;
    dispose: () => void;
  } {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const unwatchSession = this.sessions.watchToolSessionInvalidation?.(session.id, session.clerkGeneration, abort) ?? (() => {});
    const unwatchRuntime = runtime ? this.runtimeRegistry.watchInvalidation(runtime, abort) : () => {};
    const signal = AbortSignal.any([parentSignal, controller.signal]);
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      unwatchSession();
      unwatchRuntime();
    };
    signal.addEventListener('abort', dispose, { once: true });
    if (signal.aborted) dispose();
    return { signal, dispose };
  }
}

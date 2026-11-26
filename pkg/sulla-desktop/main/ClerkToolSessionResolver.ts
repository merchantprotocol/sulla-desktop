// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { ClerkError, type ClerkCaller } from '@pkg/agent/integrations/clerk/ClerkClient';
import { CLERK_ACCOUNT, CLERK_DEADLINE_MS } from '@pkg/agent/integrations/clerk/ClerkEndpoints';
import { sessionAllowsTool } from './toolSessionPolicy';

import type { AgentAwarenessPolicy } from '@pkg/agent/services/AgentAwarenessPolicy';

import type { ToolExecutionContext } from '@pkg/agent/tools/executionContext';
import type { ClerkWorker } from '@pkg/agent/tools/clerk/ClerkWorker';
import type { ToolSession } from './mcpToolSessions';

interface ToolSessionLookup {
  getToolSession(token: string): ToolSession | null;
  peekToolSession?(token: string): ToolSession | null;
}

interface LocalContextIssuer {
  issueLocalBrokerContext(input: {
    agentId: string;
    podId: string;
    credentialScope: NonNullable<ToolExecutionContext['credential_scope']>;
    threadId: string;
    signal: AbortSignal;
  }): Promise<ToolExecutionContext>;
}

/** Resolves Clerk callers only from the authenticated, live tool-session bearer. */
export class ClerkToolSessionResolver {
  constructor(
    private readonly sessions: ToolSessionLookup,
    private readonly localContexts: LocalContextIssuer,
    private readonly installationToken: () => string | null,
    private readonly awarenessPolicy: AgentAwarenessPolicy,
    private readonly now: () => number = Date.now,
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

  /** The installation bearer authenticates only the service. Never install its serialized context on a Clerk worker. */
  async bindForwarded(worker: ClerkWorker, name: string, sessionId: unknown, forwarded: ToolExecutionContext | undefined, signal: AbortSignal): Promise<void> {
    if (typeof sessionId !== 'string' || !sessionId || sessionId === this.installationToken() ||
        worker.name !== name || typeof worker.bindClerkCaller !== 'function') {
      throw new ClerkError(403, 'Clerk requires a verified agent tool session.');
    }
    const generation = forwarded?.tool_session_generation;
    const scope = forwarded?.credential_scope;
    if (!forwarded || typeof generation !== 'string' || !generation.trim() || !Number.isFinite(forwarded.exp) ||
        (scope && (scope.integration_id !== 'clerk' || scope.account_id !== CLERK_ACCOUNT || scope.item_id || scope.repository))) {
      throw new ClerkError(403, 'A session-bound container lease is required for forwarded Clerk calls. Use a transport v2 agent image.');
    }
    const { state, ...caller } = await this.resolveBearer(sessionId, name, signal, undefined, {
      generation, expiresAt: forwarded.exp * 1000, identity: forwarded,
    });
    worker.setState(state);
    worker.bindClerkCaller(caller);
  }

  /** Resolve the already-authenticated MCP session captured by its handler. */
  resolveSession(sessionId: string, name: string, signal: AbortSignal, expectedState?: ToolSession['state']): Promise<ClerkCaller> {
    const installationToken = this.installationToken();
    if (!sessionId || (installationToken && sessionId === installationToken)) {
      throw new ClerkError(403, 'Clerk requires a verified agent tool session.');
    }
    return this.resolveBearer(sessionId, name, signal, expectedState).then(({ state: _state, ...caller }) => caller);
  }

  /** Server records prove eligibility; claims and graph allowlists can only further restrict it. */
  private authorityDeadline(session: ToolSession, name: string): number {
    const deny = () => new ClerkError(403, 'The Clerk tool session is invalid or expired.');
    const now = this.now();
    if (!Number.isFinite(session.expiresAt) || session.expiresAt <= now) throw deny();
    const pair = session.clerk;
    if (pair === 'local' && !session.executionContext) return session.expiresAt;
    const execution = session.executionContext;
    if (!pair || typeof pair !== 'object' || !execution?.jti || pair.generation !== execution.jti ||
        !Number.isFinite(pair.expiresAt) || now >= pair.expiresAt) throw deny();
    const until = Math.min(session.expiresAt, pair.expiresAt);
    if (!pair.parent) return until;

    // Only launchers can sponsor provider processes. Do not slide their idle expiry here.
    const root = this.sessions.peekToolSession?.(pair.parent.id);
    const rootPair = root?.clerk;
    const ctx = root?.executionContext;
    const meta = root?.state.metadata;
    if (!root || !ctx || !rootPair || typeof rootPair !== 'object' || rootPair.parent ||
        rootPair.generation !== pair.parent.generation || ctx.jti !== rootPair.generation ||
        !Array.isArray(meta?.allowedToolNames) || !meta.allowedToolNames.length ||
        !sessionAllowsTool(meta.allowedToolNames, name, meta, this.awarenessPolicy)) throw deny();
    const deadline = Math.min(until, root.expiresAt, rootPair.expiresAt, ctx.exp * 1000);
    if (!Number.isFinite(deadline) || deadline <= now) throw deny();
    return deadline;
  }

  private async resolveBearer(bearer: string, name: string, signal: AbortSignal, expectedState?: ToolSession['state'],
    lease?: { generation: string; expiresAt: number; identity: ToolExecutionContext }) {
    const startedAt = this.now();
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(CLERK_DEADLINE_MS)]);

    const resolveSession = async(pinnedState = expectedState) => {
      const session = this.sessions.getToolSession(bearer);
      if (!session || (pinnedState && session.state !== pinnedState)) throw new ClerkError(403, 'The Clerk tool session is invalid or expired.');
      const expiresAt = this.authorityDeadline(session, name);
      const metadata = session.state?.metadata as Record<string, unknown> | undefined;
      const allowed = metadata?.allowedToolNames;
      if (!Array.isArray(allowed) || allowed.length === 0 || !sessionAllowsTool(allowed, name, metadata, this.awarenessPolicy)) {
        throw new ClerkError(403, 'This tool session is not authorized for Clerk.');
      }
      const agentId = String(metadata?.agentId ?? session.executionContext?.agent_id ?? '').trim();
      const threadId = String(metadata?.threadId ?? session.executionContext?.thread_id ?? '').trim();
      if (!agentId || !threadId) throw new ClerkError(403, 'The Clerk tool session is missing trusted agent context.');
      let execution = session.executionContext;
      if (lease) {
        const fields = ['sub', 'org_id', 'agent_id', 'pod_id', 'thread_id', 'job_id', 'device_id', 'workflow_execution_id', 'task_index'] as const;
        if (!execution || execution.jti !== lease.generation || fields.some(field => lease.identity[field] !== execution![field]) ||
            this.now() >= lease.expiresAt || this.now() >= session.expiresAt) {
          throw new ClerkError(403, 'The forwarded Clerk lease no longer matches its live session.');
        }
      }
      if (execution) {
        if (execution.exp <= Math.floor(this.now() / 1_000) || execution.agent_id !== agentId ||
            execution.thread_id !== threadId || !execution.sub || !execution.pod_id) {
          throw new ClerkError(403, 'The Clerk tool session execution context is invalid or expired.');
        }
      } else {
        execution = await this.localContexts.issueLocalBrokerContext({
          agentId,
          podId: 'desktop-main',
          credentialScope: { integration_id: 'clerk', account_id: CLERK_ACCOUNT },
          threadId,
          signal: requestSignal,
        });
      }
      return { execution, metadata, state: session.state, generation: session.executionContext?.jti, expiresAt };
    };

    const resolved = await resolveSession();
    const channel = resolved.metadata?.wsChannel;
    const deadlineAt = Math.min(startedAt + CLERK_DEADLINE_MS, resolved.execution.exp * 1_000,
      resolved.expiresAt, ...(lease ? [lease.expiresAt] : []));
    const boundedSignal = AbortSignal.any([requestSignal, AbortSignal.timeout(Math.max(1, deadlineAt - this.now()))]);
    return {
      state: resolved.state,
      execution: resolved.execution,
      conversationId: String(resolved.metadata?.threadId ?? resolved.execution.thread_id ?? ''),
      channel: typeof channel === 'string' ? channel : undefined,
      toolName: name,
      deadlineAt,
      signal: boundedSignal,
      revalidate: async() => {
        if (boundedSignal.aborted || this.now() >= deadlineAt) throw new ClerkError(403, 'The Clerk session authorization expired.');
        // Registry rebind mutates a ToolSession in place. Pin the original graph and scalar issuance, not that record.
        const current = await resolveSession(resolved.state);
        if (current.generation !== resolved.generation) {
          throw new ClerkError(403, 'The Clerk session generation changed.');
        }
        return current.execution;
      },
    };
  }
}

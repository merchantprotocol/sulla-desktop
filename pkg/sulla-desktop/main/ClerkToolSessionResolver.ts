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
    const { state, ...caller } = await this.resolveBearer(sessionId, name, signal);
    const fields = ['sub', 'org_id', 'agent_id', 'pod_id', 'thread_id', 'job_id', 'device_id', 'workflow_execution_id', 'task_index'] as const;
    const scope = forwarded?.credential_scope;
    if (!forwarded || fields.some(field => forwarded[field] !== caller.execution[field]) ||
        (scope && (scope.integration_id !== 'clerk' || scope.account_id !== CLERK_ACCOUNT || scope.item_id || scope.repository))) {
      throw new ClerkError(403, 'The forwarded Clerk identity does not match its agent session.');
    }
    worker.setState(state);
    worker.bindClerkCaller(caller);
  }

  /** Resolve the already-authenticated MCP session captured by its handler. */
  resolveSession(sessionId: string, name: string, signal: AbortSignal): Promise<ClerkCaller> {
    const installationToken = this.installationToken();
    if (!sessionId || (installationToken && sessionId === installationToken)) {
      throw new ClerkError(403, 'Clerk requires a verified agent tool session.');
    }
    return this.resolveBearer(sessionId, name, signal).then(({ state: _state, ...caller }) => caller);
  }

  private async resolveBearer(bearer: string, name: string, signal: AbortSignal) {
    const startedAt = this.now();
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(CLERK_DEADLINE_MS)]);

    const resolveSession = async() => {
      const session = this.sessions.getToolSession(bearer);
      if (!session) throw new ClerkError(403, 'The Clerk tool session is invalid or expired.');
      const metadata = session.state?.metadata as Record<string, unknown> | undefined;
      const allowed = metadata?.allowedToolNames;
      if (!Array.isArray(allowed) || allowed.length === 0 || !sessionAllowsTool(allowed, name, metadata, this.awarenessPolicy)) {
        throw new ClerkError(403, 'This tool session is not authorized for Clerk.');
      }
      const agentId = String(metadata?.agentId ?? session.executionContext?.agent_id ?? '').trim();
      const threadId = String(metadata?.threadId ?? session.executionContext?.thread_id ?? '').trim();
      if (!agentId || !threadId) throw new ClerkError(403, 'The Clerk tool session is missing trusted agent context.');
      let execution = session.executionContext;
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
      return { execution, metadata, state: session.state };
    };

    const resolved = await resolveSession();
    const channel = resolved.metadata?.wsChannel;
    const deadlineAt = Math.min(startedAt + CLERK_DEADLINE_MS, resolved.execution.exp * 1_000);
    const boundedSignal = AbortSignal.any([requestSignal, AbortSignal.timeout(Math.max(1, deadlineAt - this.now()))]);
    return {
      state: resolved.state,
      execution: resolved.execution,
      conversationId: String(resolved.metadata?.threadId ?? resolved.execution.thread_id ?? ''),
      channel: typeof channel === 'string' ? channel : undefined,
      toolName: name,
      deadlineAt,
      signal: boundedSignal,
      revalidate: async() => (await resolveSession()).execution,
    };
  }
}

// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash } from 'node:crypto';
import { issueCapabilityToken } from '@pkg/runtime/capabilityToken';
import type { ToolSession } from '@pkg/main/mcpToolSessions';
import type { AgentContainerRuntimeBinding } from './AgentContainerRuntimeRegistry';

export interface SessionLeaseFiles {
  replace(name: string, value: string): Promise<void>;
  remove(name: string): Promise<void>;
}

/** One issuer per container lifecycle. Only the session registry supplies the issuance generation. */
export class ContainerSessionLeases {
  private readonly processes = new Set<string>();
  private pending: Promise<void> = Promise.resolve();
  private closed = false;
  private launcher?: { id: string; owned: () => boolean };
  expiresAt = 0;

  constructor(
    private readonly binding: AgentContainerRuntimeBinding,
    private readonly sessions: { peekToolSession(id: string): ToolSession | null; revokeSession(id: string): void; ownLauncherSession(id: string): () => boolean },
    private readonly scopes: string[],
    private readonly lifecycleId: string,
    private readonly signingKey: Buffer,
    private readonly ttlMs: number,
    private readonly files: SessionLeaseFiles,
    private readonly version: '1' | '2' = '2',
    private readonly ceiling = Infinity,
  ) {}

  /** Establish the single launcher default. Process leases never acquire ownership. */
  issue(id: string): string {
    if (this.launcher && (this.launcher.id !== id || !this.launcher.owned())) throw new Error('Launcher session not owned');
    const token = this.sign(id);
    this.launcher ??= { id, owned: this.sessions.ownLauncherSession(id) };
    return token;
  }

  private sign(id: string): string {
    const session = this.sessions.peekToolSession(id);
    const ctx = session?.executionContext;
    const b = this.binding;
    const now = Math.floor(Date.now() / 1000);
    if (this.closed || !session || !ctx?.jti || ctx.pod_id !== b.podId || ctx.sub !== b.subject ||
        ctx.org_id !== b.orgId || ctx.agent_id !== b.agentId || ctx.job_id !== b.jobId ||
        ctx.task_index !== b.taskIndex || ctx.thread_id !== b.threadId || ctx.device_id !== b.deviceId) {
      throw new Error('No live tool session for this container lease');
    }
    const exp = Math.min(this.ceiling, ctx.exp, Math.floor(session.expiresAt / 1000), now + Math.ceil(this.ttlMs / 1000));
    if (exp <= now) throw new Error('Container tool session expired');
    this.expiresAt = Math.max(this.expiresAt, exp);
    // The v2 generation binds ordinary CLI traffic; signing must never grant Clerk.
    return issueCapabilityToken({
      sub: b.subject, org_id: b.orgId, agent_id: b.agentId, pod_id: b.podId, thread_id: b.threadId,
      job_id: b.jobId, task_index: b.taskIndex, device_id: b.deviceId, scopes: this.scopes,
      ...(this.version === '2' ? { tool_session_generation: ctx.jti } : {}), jti: this.lifecycleId, expiresInSeconds: exp - now,
    }, this.signingKey);
  }

  private file(id: string): string {
    return 'LEASE_' + createHash('sha256').update(id).digest('hex').toUpperCase();
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => {});
    return result;
  }

  prepare(id: string): Promise<void> {
    return this.enqueue(async() => {
      const lease = this.sign(id);
      this.processes.add(id);
      await this.files.replace(this.file(id), lease);
    });
  }

  retire(id: string): Promise<void> {
    return this.enqueue(async() => {
      if (!this.processes.has(id)) return;
      await this.files.remove(this.file(id));
      this.processes.delete(id);
    });
  }

  renew(id: string, rebindLauncher: () => boolean): Promise<void> {
    return this.enqueue(async() => {
      if (this.closed) return;
      if (this.launcher?.id !== id || !this.launcher.owned() || !rebindLauncher()) {
        throw new Error('Launcher tool session revoked or not owned');
      }
      const launcher = this.sign(id);
      await this.files.replace('SULLA_API_TOKEN', launcher);
      for (const process of this.processes) {
        const live = this.sessions.peekToolSession(process);
        if (!live?.executionContext || Math.floor(Math.min(live.expiresAt / 1000, live.executionContext.exp)) <= Math.floor(Date.now() / 1000)) {
          await this.files.remove(this.file(process));
          this.processes.delete(process);
        } else {
          // Do not slide the session, change its graph, or rebind its generation.
          const signed = this.sign(process);
          await this.files.replace(this.file(process), signed);
        }
      }
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    // A call already held at Decide must lose its session even before guest I/O drains.
    if (this.launcher?.owned()) this.sessions.revokeSession(this.launcher.id);
    for (const id of this.processes) this.sessions.revokeSession(id);
    await this.pending;
    this.processes.clear(); // The lifecycle removes the entire private directory.
  }
}

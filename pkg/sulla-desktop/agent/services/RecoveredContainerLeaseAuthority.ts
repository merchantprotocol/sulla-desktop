// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { ToolExecutionContext } from '../tools/executionContext';
import type { AgentContainerRuntimeBinding } from './AgentContainerRuntimeRegistry';
import type { ContainerSessionLeases } from './ContainerSessionLeases';

type Inventory = {
  Id?: string;
  Config?: { User?: string; Labels?: Record<string, string> };
  Mounts?: Array<{ Type: string; Destination: string; Source: string }>;
};

type CreateIssuer = (binding: AgentContainerRuntimeBinding, scopes: string[], lifecycle: string,
  directory: string, uid: number, gid: number, ceiling: number, containerId: string) => ContainerSessionLeases;

/** Recover only from Docker's launch metadata. Never read authority from a worker's files. */
export class RecoveredContainerLeaseAuthority {
  private readonly inventory = new WeakMap<AgentContainerRuntimeBinding, Inventory>();
  constructor(private readonly create: CreateIssuer) {}

  remember(binding: AgentContainerRuntimeBinding, details: Inventory, containerId: string): void {
    if (details.Config?.Labels?.['com.sulla.agent.transport-version'] !== '2') return;
    // Keep only the relevant fields, not the entire inspection (which includes process env).
    const labels = details.Config.Labels;
    this.inventory.set(binding, { Id: containerId, Config: { User: details.Config.User, Labels: {
      'com.sulla.capability-jti': labels['com.sulla.capability-jti'],
      'com.sulla.capability-scopes': labels['com.sulla.capability-scopes'],
    } }, Mounts: details.Mounts?.filter(m => m.Destination === '/run/secrets/sulla-agent') });
  }

  issuer(binding: AgentContainerRuntimeBinding, caller?: ToolExecutionContext): ContainerSessionLeases | undefined {
    const details = this.inventory.get(binding);
    if (!details) return undefined; // v1: the wrapper consumes the original default.
    const labels = details.Config?.Labels;
    const lifecycle = labels?.['com.sulla.capability-jti'];
    const directory = '/dev/shm/sulla-agent-secrets/' + binding.podId + '-' + lifecycle;
    const user = /^(\d+):(\d+)$/.exec(details.Config?.User ?? '');
    if (!details.Id || !/^[a-f0-9]{12,64}$/.test(details.Id) || !lifecycle || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(lifecycle) ||
        !/^sulla-agent-[A-Za-z0-9_.-]+$/.test(binding.podId) || binding.taskIndex === undefined || !user ||
        details.Mounts?.length !== 1 || details.Mounts[0].Type !== 'bind' || details.Mounts[0].Source !== directory) {
      throw new Error('Cannot recover trusted container lease metadata');
    }
    const stored = labels?.['com.sulla.capability-scopes'];
    // Pre-label v2 images have no durable scope list. Delegate only an already
    // verified, unexpired capability from this exact lifecycle, without promoting
    // an old graph's forwarded Clerk proof into a new graph's proof.
    if (!caller && stored === undefined) throw new Error('Verified lifecycle capability required for legacy container recovery');
    if (caller && (caller.task_index !== binding.taskIndex || caller.credential_scope || caller.group_ids || caller.workflow_execution_id ||
        !Number.isFinite(caller.exp) || caller.exp <= Math.floor(Date.now() / 1000) ||
        ((stored === undefined || caller.tool_session_generation) && caller.jti !== lifecycle))) {
      throw new Error('Invalid authority for recovered container');
    }
    const scopes: unknown = stored === undefined ? caller!.scopes : JSON.parse(stored);
    if (!Array.isArray(scopes) || !scopes.every(s => typeof s === 'string')) throw new Error('Invalid recovered container scope list');
    const allowed = !caller || caller.scopes.includes('*') ? scopes : scopes.includes('*') ? caller.scopes :
      scopes.filter(scope => caller.scopes.includes(scope));
    return this.create(binding, [...allowed], lifecycle, directory, Number(user[1]), Number(user[2]),
      caller?.exp ?? Infinity, details.Id);
  }
}

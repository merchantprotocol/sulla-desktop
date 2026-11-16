// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { resolveAgentIdentity, type AgentIdentityMetadata } from '../../utils/agentIdentity';

export interface GraphRegistryEntryPort { state: { metadata: AgentIdentityMetadata } }
export interface GraphRegistryPort { get(threadId: string): GraphRegistryEntryPort | undefined }

/** Confirms the registered graph entry still represents the exact custody owner. */
export class GraphRegistryOwnerPresence {
  constructor(private readonly registry: GraphRegistryPort) {}

  matches(owner: { threadId: string; channel: string; agentId: string }): boolean {
    const entry = this.registry.get(owner.threadId);
    if (!entry) return false;
    const metadata = entry.state.metadata;
    return String(metadata.wsChannel ?? '') === owner.channel && resolveAgentIdentity(metadata) === owner.agentId;
  }
}

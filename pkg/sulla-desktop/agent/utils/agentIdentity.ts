// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export interface AgentIdentityMetadata {
  agentId?:   string;
  wsChannel?: string;
}

/**
 * Resolve the stable agent identity independently from its current transport.
 * Older/restored states may not have agentId yet, so wsChannel remains a
 * compatibility fallback.
 */
export function resolveAgentIdentity(metadata: AgentIdentityMetadata | null | undefined): string {
  return String(metadata?.agentId || metadata?.wsChannel || '').trim();
}

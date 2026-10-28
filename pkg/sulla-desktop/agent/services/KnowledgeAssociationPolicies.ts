// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Strict allowlists for the four Knowledge Base / Projects roles. Callers pass
 * these through `allowedToolNames`; readers contain no mutation operations and
 * writers receive only the cross-domain association mutations they need.
 */
export const KNOWLEDGE_ASSOCIATION_TOOL_POLICIES = {
  project_reader: ['files_where', 'files_search', 'episodic_search', 'episodic_resolve'],
  project_writer: ['files_where', 'files_search', 'episodic_search', 'episodic_resolve'],
  knowledge_reader: ['episodic_search', 'episodic_resolve', 'episodic_recall', 'files_search'],
  knowledge_writer: ['episodic_search', 'episodic_resolve', 'episodic_recall', 'files_search'],
} as const;

export type KnowledgeAssociationRole = keyof typeof KNOWLEDGE_ASSOCIATION_TOOL_POLICIES;

export const KNOWLEDGE_ASSOCIATION_AGENT_ROLES = {
  'project-reader':        'project_reader',
  'project-writer':        'project_writer',
  'knowledge-base-reader': 'knowledge_reader',
  'knowledge-base-writer': 'knowledge_writer',
} as const satisfies Record<string, KnowledgeAssociationRole>;

export type KnowledgeAssociationAgentId = keyof typeof KNOWLEDGE_ASSOCIATION_AGENT_ROLES;

export function knowledgeAssociationRoleForAgentId(agentId: string): KnowledgeAssociationRole | null {
  const normalized = agentId.trim().toLowerCase() as KnowledgeAssociationAgentId;
  return KNOWLEDGE_ASSOCIATION_AGENT_ROLES[normalized] ?? null;
}

export function isKnowledgeAssociationAgentId(agentId: string): boolean {
  return knowledgeAssociationRoleForAgentId(agentId) !== null;
}

export function knowledgeAssociationToolsFor(role: KnowledgeAssociationRole): string[] {
  return [...KNOWLEDGE_ASSOCIATION_TOOL_POLICIES[role]];
}

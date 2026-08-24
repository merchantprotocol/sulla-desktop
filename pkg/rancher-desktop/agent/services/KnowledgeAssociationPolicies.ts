/**
 * Strict allowlists for the four Knowledge Base / Projects roles. Callers pass
 * these through `allowedToolNames`; readers contain no mutation operations and
 * writers receive only the cross-domain association mutations they need.
 */
export const KNOWLEDGE_ASSOCIATION_TOOL_POLICIES = {
  project_reader: [
    'get_project_item',
    'list_linked_knowledge',
    'episodic_search',
    'episodic_resolve',
  ],
  project_writer: [
    'get_project_item',
    'list_linked_knowledge',
    'episodic_search',
    'episodic_resolve',
    'link_knowledge_item',
    'unlink_knowledge_item',
  ],
  knowledge_reader: [
    'episodic_search',
    'episodic_resolve',
    'episodic_recall',
    'episodic_list_linked_project_items',
  ],
  knowledge_writer: [
    'episodic_search',
    'episodic_resolve',
    'episodic_recall',
    'episodic_list_linked_project_items',
    'episodic_link_project_item',
    'episodic_unlink_project_item',
    'search_project_items',
  ],
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

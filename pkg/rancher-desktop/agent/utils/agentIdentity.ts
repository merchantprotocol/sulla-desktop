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

// Shared plaintext shapes for Sulla Vault clients (Desktop, server console, extension).
// Item plaintext is JSON-encoded, then sealed with encryptItem(); the server never sees it.
// agentPolicy is stored twice: inside the ciphertext (source of truth for the owner) and as
// plaintext items.agent_policy so the server can refuse agent use without decrypting.

export type VaultItemType = 'login' | 'note' | 'card' | 'identity' | 'apiKey';

export type UriMatch = 'domain' | 'host' | 'startsWith' | 'exact' | 'never';

export interface VaultItemUri {
  uri: string;
  match?: UriMatch;
}

export interface VaultCustomField {
  name: string;
  value: string;
  hidden?: boolean;
}

/** Plaintext of one vault item before encryption. */
export interface VaultItemPlaintext {
  type: VaultItemType;
  name: string;
  favorite?: boolean;
  username?: string;
  password?: string;
  /** otpauth:// URI or base32 secret. */
  totp?: string;
  uris?: VaultItemUri[];
  notes?: string;
  fields?: VaultCustomField[];
  card?: { holder?: string; brand?: string; number?: string; expMonth?: string; expYear?: string; code?: string };
  identity?: Record<string, string>;
  passwordHistory?: { password: string; changedAt: string }[];
  agentPolicy: AgentPolicy;
}

/** Metadata: agents see the item exists. Autofill: Sulla fills it, agent never sees it. Full: agent can read it. */
export type AgentAccessLevel = 'metadata' | 'autofill' | 'full';

export interface AgentPolicy {
  /** 'only_me' blocks every agent regardless of the other fields. */
  mode: 'only_me' | 'agents';
  level: AgentAccessLevel;
  /** Agent ids allowed; empty = all of the owner's agents. */
  agents: string[];
  /** Hostnames the credential may be used on; empty = any. */
  sites: string[];
  /** ISO timestamp after which agent access stops; null = never. */
  expiresAt: string | null;
  /** Ask the owner before each agent use. */
  askFirst: boolean;
  /** Owner's agents running on the org server may use it too. */
  allowServerAgents: boolean;
}

export const DEFAULT_AGENT_POLICY: AgentPolicy = {
  mode: 'only_me',
  level: 'metadata',
  agents: [],
  sites: [],
  expiresAt: null,
  askFirst: false,
  allowServerAgents: false,
};

/** Maps the legacy Desktop llm_access values onto the new policy (blank today = autofill). */
export function agentPolicyFromLegacyLlmAccess(value: string | null | undefined): AgentPolicy {
  const v = (value ?? '').trim().toLowerCase();
  if (v === 'none') {
    return { ...DEFAULT_AGENT_POLICY };
  }
  const level: AgentAccessLevel = v === 'full' ? 'full' : v === 'metadata' ? 'metadata' : 'autofill';
  return { ...DEFAULT_AGENT_POLICY, mode: 'agents', level };
}

/** Server-side check for an agent use request. Pure so every service can share it. */
export function agentPolicyAllows(
  policy: AgentPolicy | null | undefined,
  request: { agentId: string; level: AgentAccessLevel; host?: string; onServer?: boolean; now?: Date },
): { allowed: boolean; reason?: string } {
  if (!policy || policy.mode !== 'agents') return { allowed: false, reason: 'Only the owner can use this item' };
  const rank: Record<AgentAccessLevel, number> = { metadata: 0, autofill: 1, full: 2 };
  if (rank[request.level] > rank[policy.level]) return { allowed: false, reason: `Agents are limited to ${policy.level}` };
  if (policy.agents.length && !policy.agents.includes(request.agentId)) return { allowed: false, reason: 'This agent is not on the allowed list' };
  if (policy.expiresAt && (request.now ?? new Date()) > new Date(policy.expiresAt)) return { allowed: false, reason: 'Agent access has expired' };
  if (request.onServer && !policy.allowServerAgents) return { allowed: false, reason: 'Server agents are not allowed for this item' };
  if (policy.sites.length && request.host) {
    const host = request.host.toLowerCase();
    if (!policy.sites.some((s) => host === s.toLowerCase() || host.endsWith(`.${ s.toLowerCase() }`))) {
      return { allowed: false, reason: `Not allowed on ${ host }` };
    }
  }
  return { allowed: true };
}

/**
 * Per-account AI access policy for vault credentials (the `llm_access` field).
 *
 *   none      — AI cannot see or use the credential
 *   metadata  — AI sees non-secret fields only
 *   autofill  — AI may use it through Sulla-controlled paths (browser autofill,
 *               native tools) but never receives the secret value
 *   full      — AI may read and use every value
 *
 * The level is chosen by the human. Agents must never be able to raise it,
 * and must not be able to route a secret into code they author (functions,
 * workflow steps) unless the account allows it.
 */

export type LlmAccessLevel = 'none' | 'metadata' | 'autofill' | 'full';

/** Properties only the human (UI) may write; agent tools must refuse them. */
export const AGENT_PROTECTED_PROPERTIES = new Set(['llm_access']);

/** Integrations that hold human login passwords rather than service API keys. */
const HUMAN_LOGIN_INTEGRATIONS = new Set(['website']);

export function resolveLlmAccess(stored: string | null | undefined): LlmAccessLevel {
  return stored === 'none' || stored === 'metadata' || stored === 'full' ? stored : 'autofill';
}

/**
 * May a secret from this account be injected into agent-authored code
 * (function env vars, workflow capability tokens)? Such code can print the
 * value back to the agent, so this is equivalent to "the AI can read it".
 *
 *   - none / metadata: never.
 *   - website logins: only with full access (autofill means "never see").
 *   - service integrations (API keys) at autofill: allowed — that is the
 *     documented "use for tool integrations" meaning of autofill.
 */
export function mayInjectSecretIntoAgentCode(integrationId: string, level: LlmAccessLevel): boolean {
  if (level === 'none' || level === 'metadata') return false;
  if (HUMAN_LOGIN_INTEGRATIONS.has(integrationId)) return level === 'full';

  return true;
}

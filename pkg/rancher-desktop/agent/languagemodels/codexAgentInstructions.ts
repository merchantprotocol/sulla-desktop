/**
 * Agent-specific instructions for Codex runs.
 *
 * Codex reads its system context from the shared ~/.codex/AGENTS.md, which is
 * always built for the default agent. A spawned agent (codex-sol-worker,
 * codex-luna-worker, …) would otherwise never see its own database prompt, so
 * it rides along in the <sulla_context> stable tier of the user message.
 */

import { DEFAULT_CORE_ROUTINE_AGENT_ID } from '../routines/core/defaultCoreAgent';
import { resolveAgentIdentity, type AgentIdentityMetadata } from '../utils/agentIdentity';

export type AgentPromptLoader = (agentId: string) => Promise<{ genericPrompt: string; config: { name?: string } | null } | null>;

export async function buildCodexAgentInstructions(
  metadata: AgentIdentityMetadata | null | undefined,
  loadPrompt: AgentPromptLoader,
): Promise<string> {
  const agentId = resolveAgentIdentity(metadata);
  if (!agentId || agentId === DEFAULT_CORE_ROUTINE_AGENT_ID) return '';

  let data: Awaited<ReturnType<AgentPromptLoader>> = null;
  try {
    data = await loadPrompt(agentId);
  } catch {
    return '';
  }
  const prompt = data?.genericPrompt?.trim();
  if (!prompt) return '';

  const name = data?.config?.name || agentId;
  return `<agent_instructions agent="${ agentId }">
You are running as the "${ name }" agent. These are your role instructions. They take precedence over any conflicting general guidance in AGENTS.md or elsewhere in this context.

${ prompt }
</agent_instructions>`;
}

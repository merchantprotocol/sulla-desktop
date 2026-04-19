/**
 * buildFullSystemPrompt — Assembles the full Sulla system prompt outside of a
 * graph node, for callers that talk to an LLM directly (e.g. ClaudeCodeService,
 * which spawns `claude -p` inside the Lima VM and needs every non-node LLM call
 * to still carry the Sulla runtime context).
 *
 * Mirrors the BaseNode.buildSystemPrompt flow but doesn't require a state or
 * a running node: we just construct a minimal PromptBuildContext and hand it to
 * SystemPromptBuilder.build.
 *
 * The registered sections live in ../prompts/sections/index; importing it here
 * ensures they are registered before the first build.
 */

import './sections/index';

import { getPrimaryService } from '../languagemodels';
import { buildIntegrationsIndex, getTemplateVariables, loadAgentPromptData, type AgentPromptLoadResult } from '../nodes/BaseNode';
import { SystemPromptBuilder, type AgentConfig, type PromptBuildContext } from './SystemPromptBuilder';

export interface BuildFullSystemPromptOptions {
  /** Agent identifier (used to pick up agent-specific .md overrides). Defaults to 'sulla-desktop'. */
  agentId?:    string;
  /** Prompt mode. Defaults to 'full' — callers that want a condensed prompt pass 'local'. */
  mode?:       'full' | 'minimal' | 'local' | 'none';
  /** Trust level. Defaults to 'trusted' — this helper runs for the signed-in local user. */
  trustLevel?: 'trusted' | 'verify' | 'untrusted';
  /** Override provider name for sections that vary by provider. Defaults to the active primary provider, or 'anthropic'. */
  provider?:   string;
  /** Base prompt appended at the end of the built sections. */
  basePrompt?: string;
}

/**
 * Build the full Sulla system prompt and return the joined text.
 *
 * Safe to call from any context — lazy-loads services and catches section
 * errors internally via SystemPromptBuilder.
 */
export async function buildFullSystemPrompt(
  options: BuildFullSystemPromptOptions = {},
): Promise<string> {
  const agentId = options.agentId ?? 'sulla-desktop';
  const mode = options.mode ?? 'full';
  const trustLevel = options.trustLevel ?? 'trusted';

  // Template variables — identical to BaseNode's setup so every {{placeholder}}
  // in the section bodies resolves the same way as the regular agent path.
  const templateVars = await getTemplateVariables();
  templateVars['{{agent_id}}'] = agentId;
  templateVars['{{agent_name}}'] = templateVars['{{botName}}'] || agentId;

  // Integrations index — pass undefined so every configured integration is listed.
  templateVars['{{integrations_index}}'] = await buildIntegrationsIndex();

  // Load agent-specific .md overrides if an agent dir exists for this id.
  let agentSectionOverrides = new Map<string, string>();
  let excludeSections = new Set<string>();
  let agentConfig: AgentConfig | null = null;

  try {
    const agentData: AgentPromptLoadResult | null = await loadAgentPromptData(agentId);
    if (agentData) {
      agentSectionOverrides = agentData.sectionOverrides;
      excludeSections = new Set(agentData.excludeSections);
      agentConfig = agentData.config ?? null;
      if (agentData.genericPrompt) {
        agentConfig = { ...(agentConfig ?? {}), prompt: agentData.genericPrompt };
      }
    }
  } catch {
    // loadAgentPromptData only throws in catastrophic cases; fall back to empty overrides.
  }

  // Provider — default to the active primary provider so provider-conditional
  // sections (e.g. "Anthropic vs OpenAI response formatting") behave correctly.
  let provider = options.provider;
  if (!provider) {
    try {
      const llm = await getPrimaryService();
      provider = llm?.getProviderName?.() || 'anthropic';
    } catch {
      provider = 'anthropic';
    }
  }

  const buildCtx: PromptBuildContext = {
    mode,
    agentId,
    agentConfig,
    provider,
    chatMode:              'text',
    trustLevel,
    isSubAgent:            false,
    isHeartbeat:           false,
    wsChannel:             'sulla-desktop',
    templateVars,
    agentSectionOverrides,
    excludeSections,
    basePrompt:            options.basePrompt ?? '',
  };

  const built = await SystemPromptBuilder.build(buildCtx);
  return built.text;
}

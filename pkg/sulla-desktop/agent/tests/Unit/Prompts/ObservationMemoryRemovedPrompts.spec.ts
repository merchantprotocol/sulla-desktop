// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
// Observation memory and identity observations are removed. The prompt a graph agent, a Claude
// Code agent and a Codex agent receive must carry no observation block and no instruction to use
// observation tools, while v7 brain_memory recall still arrives. The human's `user` Personality
// row remains assistant context under its original wrapper. The real BaseNode.enrichPrompt,
// SystemPromptBuilder, context injector and both CLI prefix builders run; the definition lookup,
// settings, DB prompt-section rows and the skills/Files/extension/integration reads are faked.
import '../../Support/TestHomeEnv';

import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SullaSettingsModel } from '../../../database/models/SullaSettingsModel';
import { SystemPromptSectionModel } from '../../../database/models/SystemPromptSectionModel';
import { createClaudeCodeService } from '../../../languagemodels/ClaudeCodeService';
import { createCodexService } from '../../../languagemodels/CodexService';
import { BaseNode } from '../../../nodes/BaseNode';
import { agentDefinitionService } from '../../../services/AgentDefinitionService';

import type { BaseThreadState, NodeResult } from '../../../nodes/Graph';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => '0.0.0-test', isPackaged: false }, safeStorage: {} }));
vi.mock('@pkg/agent/database/registry/SkillsRegistry', () => ({ skillsRegistry: { getSkillSummaries: async() => [], getSkill: async() => null } }));
vi.mock('@pkg/agent/files/containerClient', () => ({ filesContainerJson: async() => [] }));
vi.mock('@pkg/agent/services/ExtensionService', () => ({ getExtensionService: () => ({ initialize: async() => undefined, fetchInstalledExtensions: async() => [] }) }));
vi.mock('@pkg/agent/services/IntegrationService', () => ({ getIntegrationService: () => ({ initialize: async() => undefined, getConnectionStatus: async() => ({ connected: false }), onValueChange: () => undefined }) }));
vi.mock('../../../languagemodels/ProviderExecutionTransport', () => ({
  getProviderExecutionTransport: vi.fn(), requireBrokeredContainerAuth: () => ({}), requireContainerToolConfig: () => ({}),
}));

const IDENTITY_PROFILE = 'IDENTITY_PROFILE_FROM_DREAMED_OBSERVATIONS';
const HUMAN_PROFILE = 'HUMAN_AUTHORED_PROFILE_FROM_PERSONALITY_SETTINGS';
const STALE_OBSERVATION = 'STALE_TOP_TEN_OBSERVATION';
const BRAIN_FACT = '[memory:42] durable subject-memory rule';

/** Finds anything in prompt text that shows or advertises the removed observation systems. */
class ObservationPromptAudit {
  private readonly forbidden = [
    /<\/?observational_memory>/i,
    /<\/?[a-z_]*observations?(?:_context)?>/i,
    /top-10 observations/i,
    /observational[- ]memory tool/i,
    /add_observational_memory|remove_observational_memory/,
    /search_observations|list_observations/,
    /identity_observations?|update_identity_section/,
  ];

  violations(text: string): string[] {
    return this.forbidden.filter(pattern => pattern.test(text)).map(String);
  }
}

class GraphAgentProbe extends BaseNode {
  constructor() { super('observation-removal-probe', 'Observation removal probe') }
  async execute(state: BaseThreadState): Promise<NodeResult<BaseThreadState>> { return { state, decision: { type: 'end' } } as any }
  protected async resolveLoopProvider(): Promise<any> { return { getProviderName: () => 'grok' } }
  async promptAndContext(state: BaseThreadState): Promise<{ system: string; injected: string }> {
    const system = await this.enrichPrompt('', state, {} as any);
    this.injectSubconsciousAssistantContext(state);
    const injected = state.messages
      .filter((message: any) => message.metadata?.source === 'subconscious_context')
      .map((message: any) => String(message.content)).join('\n');
    return { system, injected };
  }
}

/** A thread whose metadata still carries values an older build stored for the removed systems. */
function threadState(agentId: string): BaseThreadState {
  return {
    metadata: {
      threadId:                   'observation-removal',
      agentId,
      wsChannel:                  'sulla-desktop',
      agent:                      { name: 'Probe', prompt: 'Do the assigned work.' },
      brainMemoryContext:         BRAIN_FACT,
      observationalMemoryContext: STALE_OBSERVATION,
      humanIdentityContext:       STALE_OBSERVATION,
      observationContext:         STALE_OBSERVATION,
      userObservationContext:     STALE_OBSERVATION,
      selfObservationContext:     STALE_OBSERVATION,
    },
    messages: [{ role: 'user', content: 'Continue the task.' }],
  } as unknown as BaseThreadState;
}

const audit = new ObservationPromptAudit();

beforeEach(() => {
  vi.spyOn(agentDefinitionService, 'findBySlug').mockResolvedValue({
    id: 'agent-probe', slug: 'probe', name: 'Probe', description: 'Probe agent', enabled: true, status: 'production',
    prompt_content: 'Do the assigned work.', prompt_files: {}, config: {}, allowed_tools: [], skill_refs: [], provider: 'grok', model: null, model_slot: 'primary',
  } as any);
  vi.spyOn(SullaSettingsModel, 'get').mockImplementation(async(_key: string, fallback?: unknown) => fallback as any);
  // The dreamed identity profile row that older builds wrote with update_identity_section.
  vi.spyOn(SystemPromptSectionModel, 'list').mockResolvedValue([{
    // This is the real persisted shape for both a human edit and an old dreamer-written profile.
    id: 'user', title: 'User', content: IDENTITY_PROFILE, priority: 15, enabled: true, cache_stability: 'stable',
    is_builtin: true, is_generated: false, is_customized: true, source: 'baked-default', created_at: '2026-01-01', updated_at: null,
  }] as any);
});
afterEach(() => { vi.restoreAllMocks() });

describe('prompts after observation memory removal', () => {
  it('keeps the real persisted user Personality row in assistant context, not the system prompt', async() => {
    // risk: an old dreamed profile is moved into high-authority system instructions or purged with human notes
    const { system, injected } = await new GraphAgentProbe().promptAndContext(threadState('probe'));

    expect(system.length).toBeGreaterThan(500);
    expect(audit.violations(system)).toEqual([]);
    expect(audit.violations(injected)).toEqual([]);
    expect(system).not.toContain(IDENTITY_PROFILE);
    expect(injected).toContain(`<human_identity_context>\n${ IDENTITY_PROFILE }\n</human_identity_context>`);
    expect(`${ system }\n${ injected }`).not.toContain(STALE_OBSERVATION);
    expect(injected).toContain(`<brain_memory>\n${ BRAIN_FACT }\n</brain_memory>`);
  });

  it('keeps human-authored Personality notes in the same assistant-context wrapper', async() => {
    // risk: removing identity observations also silently removes the user's own Personality notes
    (SystemPromptSectionModel.list as any).mockResolvedValue([{
      id: 'user', title: 'User', content: HUMAN_PROFILE, priority: 15, enabled: true, cache_stability: 'stable',
      is_builtin: true, is_generated: false, is_customized: true, source: 'user', created_at: '2026-01-01', updated_at: null,
    }]);

    const { system, injected } = await new GraphAgentProbe().promptAndContext(threadState('probe'));

    expect(system).not.toContain(HUMAN_PROFILE);
    expect(injected).toContain(`<human_identity_context>\n${ HUMAN_PROFILE }\n</human_identity_context>`);
  });

  it('still excludes a disabled user section', async() => {
    // risk: disabled Personality notes are accidentally restored while preserving the enabled-row contract
    (SystemPromptSectionModel.list as any).mockResolvedValue([{
      id: 'user', title: 'User', content: HUMAN_PROFILE, priority: 15, enabled: false, cache_stability: 'stable',
      is_builtin: true, is_generated: false, is_customized: true, source: 'baked-default', created_at: '2026-01-01', updated_at: null,
    }]);

    const { system, injected } = await new GraphAgentProbe().promptAndContext(threadState('probe'));

    expect(system).not.toContain(HUMAN_PROFILE);
    expect(injected).not.toContain(HUMAN_PROFILE);
  });

  it('gives a Claude Code runtime agent no instruction to call observation tools', async() => {
    // risk: Claude Code agents are told to call a tool that no longer exists on every turn
    const service = createClaudeCodeService('claude-opus-5-5') as any;
    const prefix: string = await service.buildUserMessageContextPrefix(threadState('probe'), { convId: 'observation-removal-claude', isNewSession: true });

    expect(prefix).toContain('<platform_context>');
    expect(prefix).toContain('memory recall');
    expect(audit.violations(prefix)).toEqual([]);
    expect(prefix).not.toContain(STALE_OBSERVATION);
  });

  it('gives a Codex runtime agent no instruction to call observation tools', async() => {
    // risk: Codex agents are told to call a tool that no longer exists on every turn
    const service = createCodexService('gpt-6-luna') as any;
    const { prefix } = await service.buildUserMessageContextPrefix(threadState('probe'), { convId: 'observation-removal-codex', isNewSession: true });

    expect(prefix).toContain('<platform_context>');
    expect(prefix).toContain('memory recall');
    expect(audit.violations(prefix)).toEqual([]);
    expect(prefix).not.toContain(STALE_OBSERVATION);
  });
});

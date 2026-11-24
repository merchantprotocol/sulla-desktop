// SPDX-License-Identifier: GPL-2.0-or-later
// A custom agent defined only by its prompt (prompt_content, no prompt files) must have that prompt
// in the system prompt the model receives, as GraphRegistry.loadAgentConfig already resolves it.
// The real loadAgentPromptData, BaseNode.enrichPrompt and SystemPromptBuilder run; the definition
// lookup, settings, DB prompt-section rows, the provider lookup and the memory/skills/Files/extension/
// integration context reads are the faked boundaries.
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BaseNode, loadAgentPromptData } from '../../../nodes/BaseNode';
import { SullaSettingsModel } from '../../../database/models/SullaSettingsModel';
import { SystemPromptSectionModel } from '../../../database/models/SystemPromptSectionModel';
import { agentDefinitionService } from '../../../services/AgentDefinitionService';

import type { BaseThreadState, NodeResult } from '../../../nodes/Graph';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => '0.0.0-test', isPackaged: false }, safeStorage: {} }));
// Prompt-context boundaries (skills catalog, Files folder map, extensions, integrations): empty.
vi.mock('@pkg/agent/database/registry/SkillsRegistry', () => ({ skillsRegistry: { getSkillSummaries: async() => [], getSkill: async() => null } }));
vi.mock('@pkg/agent/files/containerClient', () => ({ filesContainerJson: async() => [] }));
vi.mock('@pkg/agent/services/ExtensionService', () => ({ getExtensionService: () => ({ initialize: async() => undefined, fetchInstalledExtensions: async() => [] }) }));
vi.mock('@pkg/agent/services/IntegrationService', () => ({ getIntegrationService: () => ({ initialize: async() => undefined, getConnectionStatus: async() => ({ connected: false }), onValueChange: () => undefined }) }));

const SENTINEL = 'Reply exactly CHAT_AGENT_OK_20261117. Do not use tools, memory, projects or external actions.';

class PromptProbeNode extends BaseNode {
  constructor() { super('prompt-probe', 'Prompt probe') }
  async execute(state: BaseThreadState): Promise<NodeResult<BaseThreadState>> { return { state, decision: { type: 'end' } } as any }
  protected async resolveLoopProvider(): Promise<any> { return { getProviderName: () => 'grok' } }
  build(state: BaseThreadState) { return this.enrichPrompt('', state, {} as any) }
}

const definition = (extra: Record<string, unknown> = {}) => ({
  id: 'agent-qa', slug: 'qa-chat-grok-20261117', name: 'QA chat Grok', description: 'QA agent', enabled: true, status: 'production',
  prompt_content: SENTINEL, prompt_files: {}, config: {}, allowed_tools: [], skill_refs: [], provider: 'grok', model: null, model_slot: 'primary',
  ...extra,
});
const state = (agentId = 'qa-chat-grok-20261117'): BaseThreadState => ({ metadata: { threadId: 't', agentId, wsChannel: 'sulla-desktop', agent: { name: 'QA chat Grok', prompt: SENTINEL } }, messages: [] }) as any;

let row: Record<string, unknown> | null;
beforeEach(() => {
  row = definition();
  vi.spyOn(agentDefinitionService, 'findBySlug').mockImplementation(async() => structuredClone(row) as any);
  vi.spyOn(SullaSettingsModel, 'get').mockImplementation(async(_key: string, fallback?: unknown) => fallback as any);
  vi.spyOn(SystemPromptSectionModel, 'list').mockResolvedValue([]);
});
afterEach(() => { vi.restoreAllMocks() });

describe('custom agent defined only by prompt_content', () => {
  it('puts the plain prompt in the generic prompt the loader returns', async() => {
    expect((await loadAgentPromptData('qa-chat-grok-20261117'))?.genericPrompt).toContain(SENTINEL);
  });

  it('puts the plain prompt in the final system prompt sent to the model', async() => {
    expect(await new PromptProbeNode().build(state())).toContain(SENTINEL);
  });

  it('keeps markdown prompt files first: prompt_content is not added when a usable file exists', async() => {
    row = definition({ prompt_files: { 'instructions.md': 'Follow the markdown instructions.' } });
    const loaded = await loadAgentPromptData('qa-chat-grok-20261117');
    expect(loaded?.genericPrompt).toContain('Follow the markdown instructions.');
    expect(loaded?.genericPrompt).not.toContain(SENTINEL);
  });

  it('keeps a section-override file an override, and still does not add prompt_content beside it', async() => {
    row = definition({ prompt_files: { 'soul.md': 'Custom soul override.' } });
    const loaded = await loadAgentPromptData('qa-chat-grok-20261117');
    expect(loaded?.sectionOverrides.get('soul')).toBe('Custom soul override.');
    expect(loaded?.genericPrompt).not.toContain(SENTINEL);
  });

  it('never treats environment.md or blank files as prompt files: prompt_content is used', async() => {
    row = definition({ prompt_files: { 'environment.md': 'Environment-only content.', 'blank.md': '   ' } });
    const loaded = await loadAgentPromptData('qa-chat-grok-20261117');
    expect(loaded?.genericPrompt).toContain(SENTINEL);
    expect(loaded?.genericPrompt).not.toContain('Environment-only content.');
  });

  it('applies template variables to prompt_content', async() => {
    row = definition({ prompt_content: 'You are {{agent_name}}.' });
    expect((await loadAgentPromptData('qa-chat-grok-20261117'))?.genericPrompt).toBe('You are QA chat Grok.');
  });

  it('stays empty and safe without prompt files or prompt_content', async() => {
    row = definition({ prompt_content: '' });
    expect((await loadAgentPromptData('qa-chat-grok-20261117'))?.genericPrompt).toBe('');
    row = definition({ prompt_content: null });
    expect((await loadAgentPromptData('qa-chat-grok-20261117'))?.genericPrompt).toBe('');
  });

  it('leaves the default Sulla agent on its built-in prompt', async() => {
    const find = vi.mocked(agentDefinitionService.findBySlug);
    await new PromptProbeNode().build(state('sulla-desktop'));
    expect(find.mock.calls.some(([slug]) => slug === 'sulla-desktop')).toBe(false);
  });
});

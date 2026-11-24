// SPDX-License-Identifier: GPL-2.0-or-later
import '../../Support/TestHomeEnv';

import { afterEach, describe, expect, it, vi } from 'vitest';

import builtinAgentDefinitions from '../../../builtinAgents/builtin-agents.json';
import { loadAgentPromptData } from '../../../nodes/BaseNode';
import { createCodexService } from '../../../languagemodels/CodexService';
import { systemPromptFromMessages } from '../../../languagemodels/cliSystemPromptFile';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getVersion: () => 'test', isPackaged: false }, safeStorage: {} }));
vi.mock('../../../nodes/BaseNode', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../nodes/BaseNode')>()),
  loadAgentPromptData: vi.fn(),
}));
vi.mock('../../../languagemodels/ProviderExecutionTransport', () => ({
  getProviderExecutionTransport: vi.fn(), requireBrokeredContainerAuth: () => ({}), requireContainerToolConfig: () => ({}),
}));

const builtinAgents = Array.isArray(builtinAgentDefinitions)
  ? builtinAgentDefinitions
  : Object.values((builtinAgentDefinitions as any).agents ?? builtinAgentDefinitions);
const codingManager = builtinAgents.find((agent: any) => agent.slug === 'coding-manager');

afterEach(() => vi.restoreAllMocks());

describe('Codex system prompt placement', () => {
  it('keeps a spawned agent prompt in system instructions and out of the first user input', async() => {
    // risk: duplicate manager instructions inflate Codex context and trigger rate limits
    const agentPrompt = codingManager.prompt.trim();
    vi.mocked(loadAgentPromptData).mockResolvedValue({
      agentName:        codingManager.name,
      genericPrompt:    agentPrompt,
      sectionOverrides: new Map(),
      excludeSections:  [],
      config:           { name: codingManager.name },
    } as any);

    const state = { metadata: { agentId: 'coding-manager', threadId: 'b5-prompt-placement' }, messages: [] } as any;
    const messages = [
      { role: 'system', content: agentPrompt },
      { role: 'user', content: 'Run the assigned task.' },
    ] as any;
    const service = createCodexService('gpt-6-luna') as any;
    const systemInstructions = systemPromptFromMessages(messages);
    const { prefix } = await service.buildUserMessageContextPrefix(state, {
      convId: 'b5-prompt-placement',
      isNewSession: true,
    });
    const transcript = service.serializeFullTranscript(messages);
    const firstUserInput = `${ prefix }\n\n${ transcript }`;

    expect(systemInstructions).toContain(agentPrompt);
    expect(firstUserInput).not.toContain(agentPrompt);
  });
});

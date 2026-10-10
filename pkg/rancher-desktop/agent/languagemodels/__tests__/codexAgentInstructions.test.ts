import { describe, expect, it, jest } from '@jest/globals';

import { buildCodexAgentInstructions, type AgentPromptLoader } from '../codexAgentInstructions';

const loaderFor = (genericPrompt: string, name?: string) =>
  jest.fn<AgentPromptLoader>(() => Promise.resolve({ genericPrompt, config: name ? { name } : null }));

describe('buildCodexAgentInstructions', () => {
  it('injects a spawned agent\'s own database prompt', async() => {
    const load = loaderFor('Commit with git -c user.name=…', 'Codex LUNA Worker');
    const out = await buildCodexAgentInstructions({ agentId: 'codex-luna-worker' }, load);

    expect(load).toHaveBeenCalledWith('codex-luna-worker');
    expect(out).toContain('<agent_instructions agent="codex-luna-worker">');
    expect(out).toContain('"Codex LUNA Worker" agent');
    expect(out).toContain('Commit with git -c user.name=…');
  });

  it('falls back to wsChannel when agentId is missing', async() => {
    const load = loaderFor('worker rules');
    const out = await buildCodexAgentInstructions({ wsChannel: 'codex-sol-worker' }, load);

    expect(load).toHaveBeenCalledWith('codex-sol-worker');
    expect(out).toContain('"codex-sol-worker" agent');
  });

  it.each([
    ['the default agent', { agentId: 'sulla-desktop' }],
    ['no identity', {}],
    ['missing metadata', undefined],
  ])('adds nothing for %s', async(_label, metadata) => {
    const load = loaderFor('should not appear');

    expect(await buildCodexAgentInstructions(metadata, load)).toBe('');
    expect(load).not.toHaveBeenCalled();
  });

  it('adds nothing when the agent has no prompt or cannot be loaded', async() => {
    expect(await buildCodexAgentInstructions({ agentId: 'x' }, loaderFor('   '))).toBe('');
    expect(await buildCodexAgentInstructions({ agentId: 'x' }, jest.fn<AgentPromptLoader>(() => Promise.resolve(null)))).toBe('');
    expect(await buildCodexAgentInstructions({ agentId: 'x' }, jest.fn<AgentPromptLoader>(() => Promise.reject(new Error('db down'))))).toBe('');
  });
});

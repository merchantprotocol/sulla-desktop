import { describe, expect, it } from '@jest/globals';

import { AGENT_COST_TIERS } from '../../database/models/AgentDefinitionModel';
import {
  BUILTIN_HOME_TOKEN,
  getBuiltinAgentSpecs,
  hashManagedContent,
  renderBuiltinAgent,
  type BuiltinAgentSpec,
} from '../index';

const spec: BuiltinAgentSpec = {
  slug:        'demo-worker',
  name:        'Demo Worker',
  description: 'Demo',
  provider:    'claude-code',
  model:       'claude-haiku-5-5',
  card:        { whenToCall: 'demos', whenNotToCall: 'prod', send: 'brief', returns: 'result', costTier: 'low', canCall: [] },
  config:      { b: 1, a: { y: 2, x: 1 } },
  soul:        'soul',
  prompt:      `Work in ${ BUILTIN_HOME_TOKEN }/Sites/worktrees`,
};

describe('built-in agent bundle', () => {
  const specs = getBuiltinAgentSpecs();

  it('ships unique, complete, callable agents', () => {
    expect(specs.length).toBeGreaterThan(0);
    const slugs = specs.map(s => s.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of specs) {
      expect(s.slug).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(s.name.trim()).not.toBe('');
      expect(s.prompt.trim()).not.toBe('');
      expect(s.card.whenToCall.trim()).not.toBe('');
      expect(s.card.send.trim()).not.toBe('');
      expect(s.card.returns.trim()).not.toBe('');
      expect(AGENT_COST_TIERS).toContain(s.card.costTier);
      for (const callee of s.card.canCall) expect(slugs).toContain(callee);
    }
  });

  it('holds no machine-specific home paths or credentials', () => {
    const text = JSON.stringify(specs);
    expect(text).not.toMatch(/\/Users\/[A-Za-z]/);
    expect(text).not.toMatch(/sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abp]-|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY/);
  });
});

describe('renderBuiltinAgent', () => {
  it('renders the home token and derives prompt files from soul/goals/prompt', () => {
    const content = renderBuiltinAgent(spec, '/Users/someone');
    expect(content.prompt_content).toBe('Work in /Users/someone/Sites/worktrees');
    expect(content.system_prompt).toBe(content.prompt_content);
    expect(content.prompt_files).toEqual({ 'soul.md': 'soul', 'prompt.md': 'Work in /Users/someone/Sites/worktrees' });
    expect(content).toMatchObject({ when_to_call: 'demos', cost_tier: 'low', can_call: [], goals_content: '' });
  });

  it('hashes content independent of object key order', () => {
    const a = renderBuiltinAgent(spec, '/home/a');
    const b = { ...a, config: { a: { x: 1, y: 2 }, b: 1 } };
    expect(hashManagedContent(b)).toBe(hashManagedContent(a));
    expect(hashManagedContent({ ...a, prompt_content: 'edited' })).not.toBe(hashManagedContent(a));
    expect(hashManagedContent(renderBuiltinAgent(spec, '/home/b'))).not.toBe(hashManagedContent(a));
  });
});

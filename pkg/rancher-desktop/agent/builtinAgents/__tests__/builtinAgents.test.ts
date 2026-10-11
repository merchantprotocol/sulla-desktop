import { describe, expect, it } from '@jest/globals';

import { AGENT_COST_TIERS } from '../../database/models/AgentDefinitionModel';
import {
  BUILTIN_GIT_COMMIT_TOKEN,
  BUILTIN_HOME_TOKEN,
  getBuiltinAgentSpecs,
  getRetiredBuiltinSlugs,
  gitCommitCommand,
  hashManagedContent,
  parseGitUserConfig,
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

  it('ships generic prompts with no owner identity', () => {
    const text = JSON.stringify(specs);
    expect(text).not.toMatch(/users\.noreply\.github\.com|user\.name="[^{<]/);
    expect(text).not.toMatch(/Jonathon(?! Byrdziak is your creator)/);
  });

  it('never ships a retired agent', () => {
    const slugs = new Set(specs.map(s => s.slug));
    for (const slug of getRetiredBuiltinSlugs()) expect(slugs.has(slug)).toBe(false);
  });

  it('marks front-door agents, led by the account manager', () => {
    for (const s of specs) expect(typeof s.config?.front_door).toBe('boolean');
    expect(specs.find(s => s.slug === 'account-manager')?.config?.front_door).toBe(true);
  });
});

describe('git identity', () => {
  it('reads [user] name and email from git config text', () => {
    const config = '[core]\n\tname = nope\n[user]\n\tname = Ada Lovelace\n\temail = "ada@example.com" # work\n[user "x"]\n\temail = skip@example.com\n';
    expect(parseGitUserConfig(config)).toEqual({ name: 'Ada Lovelace', email: 'ada@example.com' });
  });

  it('renders a commit command with the identity, or a plain one without it', () => {
    expect(gitCommitCommand({ name: 'Ada "A" Lovelace', email: 'ada@example.com' }))
      .toBe('git -c user.name="Ada A Lovelace" -c user.email="ada@example.com" commit -m "<message>"');
    expect(gitCommitCommand({ name: '', email: '' })).toBe('git commit -m "<message>"');
  });

  it('fills the commit token at render time', () => {
    const content = renderBuiltinAgent({ ...spec, prompt: `Commit: ${ BUILTIN_GIT_COMMIT_TOKEN }` }, '/home/a', { name: 'Ada', email: 'ada@example.com' });
    expect(content.prompt_content).toBe('Commit: git -c user.name="Ada" -c user.email="ada@example.com" commit -m "<message>"');
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

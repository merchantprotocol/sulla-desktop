import { describe, expect, it } from '@jest/globals';

import { DEFAULT_REFLEX_CATEGORIES, parseCategories, reflexPolicyViolation } from '../reflexPolicy';
import { latestHumanText } from '../ReflexService';

const allowed = DEFAULT_REFLEX_CATEGORIES;

describe('reflexPolicyViolation', () => {
  it('allows local, non-destructive actions', () => {
    expect(reflexPolicyViolation({ toolName: 'tab', category: 'browser', params: { url: 'http://localhost:5199' }, allowedCategories: allowed })).toBeNull();
    expect(reflexPolicyViolation({ toolName: 'open_tab', category: 'ui', params: { mode: 'projects' }, allowedCategories: allowed })).toBeNull();
  });

  it('blocks unregistered tools, disallowed categories, denied tools, and destructive args', () => {
    expect(reflexPolicyViolation({ toolName: 'nope', category: undefined, params: {}, allowedCategories: allowed })).toMatch(/not registered/);
    expect(reflexPolicyViolation({ toolName: 'pg_query', category: 'pg', params: {}, allowedCategories: allowed })).toMatch(/not allowed/);
    expect(reflexPolicyViolation({ toolName: 'docker_rm', category: 'docker', params: {}, allowedCategories: allowed })).toMatch(/never allowed/);
    expect(reflexPolicyViolation({ toolName: 'tab', category: 'browser', params: { action: 'remove' }, allowedCategories: allowed })).toMatch(/destructive/);
  });

  it('parses the allowed-categories setting with a safe default', () => {
    expect(parseCategories('')).toEqual(DEFAULT_REFLEX_CATEGORIES);
    expect(parseCategories(' ui , browser ')).toEqual(['ui', 'browser']);
  });
});

describe('latestHumanText', () => {
  it('returns the fresh human message without turn context', () => {
    expect(latestHumanText([
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: [{ type: 'text', text: 'open projects\n\n<turn_context>now=...</turn_context>' }] },
    ])).toBe('open projects');
  });

  it('ignores turns that do not end in a human message', () => {
    expect(latestHumanText([{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }])).toBe('');
    expect(latestHumanText([{ role: 'user', content: 'x', metadata: { source: 'subconscious' } }])).toBe('');
  });
});

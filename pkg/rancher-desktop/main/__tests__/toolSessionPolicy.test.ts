import { describe, expect, it } from '@jest/globals';

import { apiRequestTokenIsValid, sessionAllowsTool } from '../toolSessionPolicy';

// Mirrors FULL_AGENT_TOOL_NAMES minus ask_user_question: exec alone must reach everything.
const WORKER = ['browse_tools', 'exec', 'read_file', 'write_file'];
const VERIFIER = ['read_file', 'git_status', 'git_diff', 'github_get_pr'];

describe('sessionAllowsTool', () => {
  it('lets a dispatched worker reach the CLI catalog it was given exec for', () => {
    expect(sessionAllowsTool(WORKER, 'git_push')).toBe(true);
    expect(sessionAllowsTool(WORKER, 'create_pr')).toBe(true);
    expect(sessionAllowsTool(WORKER, 'add_task_comment')).toBe(true);
  });

  it('gives every exec session interactive tools too (no lane is restricted)', () => {
    expect(sessionAllowsTool(WORKER, 'ask_user_question')).toBe(true);
  });

  it('limits a session without exec to exactly its list', () => {
    expect(sessionAllowsTool(VERIFIER, 'github_get_pr')).toBe(true);
    expect(sessionAllowsTool(VERIFIER, 'git_push')).toBe(false);
  });

  it('does not restrict a session with no allowlist', () => {
    expect(sessionAllowsTool(undefined, 'git_push')).toBe(true);
    expect(sessionAllowsTool([], 'git_push')).toBe(true);
  });
});

describe('apiRequestTokenIsValid', () => {
  it('rejects a scoped container token immediately after its session is revoked', () => {
    const live = new Set(['container-token']);
    const lookup = (token: string) => live.has(token);

    expect(apiRequestTokenIsValid('container-token', 'desktop-token', lookup)).toBe(true);
    expect(apiRequestTokenIsValid('container-token', 'desktop-token', lookup, '/v1/chat/completions')).toBe(false);
    live.delete('container-token');
    expect(apiRequestTokenIsValid('container-token', 'desktop-token', lookup)).toBe(false);
    expect(apiRequestTokenIsValid('desktop-token', 'desktop-token', lookup)).toBe(true);
  });
});

describe('sulla_tool (graph tool surface) uses the same rule', () => {
  it('runs catalog tools for an exec session and refuses them for a verifier', async () => {
    const { buildGraphToolHandler } = await import('../graphToolSurface');
    const getTool = async () => ({ call: async () => ({ success: true, result: 'ok' }) });

    expect((await buildGraphToolHandler(WORKER, getTool)({ tool: 'git_push' })).isError).toBe(false);
    expect((await buildGraphToolHandler(WORKER, getTool)({ tool: 'ask_user_question' })).isError).toBe(false);
    expect((await buildGraphToolHandler(VERIFIER, getTool)({ tool: 'git_push' })).isError).toBe(true);
  });
});

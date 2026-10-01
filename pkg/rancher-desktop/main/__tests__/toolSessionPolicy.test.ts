import { describe, expect, it } from '@jest/globals';

import { sessionAllowsTool } from '../toolSessionPolicy';

// Mirrors MECHANICAL_WORKER_TOOLS (TaskDispatcherService) and HEARTBEAT_TOOLS (GraphRegistry).
const WORKER = ['browse_tools', 'exec', 'read_file', 'write_file'];
const VERIFIER = ['read_file', 'git_status', 'git_diff', 'github_get_pr'];

describe('sessionAllowsTool', () => {
  it('lets a dispatched worker reach the CLI catalog it was given exec for', () => {
    expect(sessionAllowsTool(WORKER, 'git_push')).toBe(true);
    expect(sessionAllowsTool(WORKER, 'create_pr')).toBe(true);
    expect(sessionAllowsTool(WORKER, 'add_task_comment')).toBe(true);
  });

  it('keeps interactive tools away from unattended agents', () => {
    expect(sessionAllowsTool(WORKER, 'ask_user_question')).toBe(false);
    expect(sessionAllowsTool([...WORKER, 'ask_user_question'], 'ask_user_question')).toBe(true);
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

describe('sulla_tool (graph tool surface) uses the same rule', () => {
  it('runs catalog tools for an exec session and refuses them for a verifier', async () => {
    const { buildGraphToolHandler } = await import('../graphToolSurface');
    const getTool = async () => ({ call: async () => ({ success: true, result: 'ok' }) });

    expect((await buildGraphToolHandler(WORKER, getTool)({ tool: 'git_push' })).isError).toBe(false);
    expect((await buildGraphToolHandler(WORKER, getTool)({ tool: 'ask_user_question' })).isError).toBe(true);
    expect((await buildGraphToolHandler(VERIFIER, getTool)({ tool: 'git_push' })).isError).toBe(true);
  });
});

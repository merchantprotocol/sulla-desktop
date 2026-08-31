import { describe, expect, it, jest } from '@jest/globals';

import { buildGraphToolHandler, resolveGraphToolSurface, type ToolResolver } from '../graphToolSurface';

describe('resolveGraphToolSurface', () => {
  it('returns null for unrestricted sessions (no graph-stamped allowlist)', () => {
    expect(resolveGraphToolSurface({})).toBeNull();
    expect(resolveGraphToolSurface({ allowedToolNames: [] })).toBeNull();
    expect(resolveGraphToolSurface(undefined)).toBeNull();
  });

  it('returns the allowlist for a dispatcher-stamped verifier session', () => {
    expect(resolveGraphToolSurface({
      verifierReadOnly: true,
      allowedToolNames: ['github_get_pr', 'get_project_item'],
    })).toEqual(['github_get_pr', 'get_project_item']);
  });

  it('returns the allowlist for a restricted non-verifier session (observer/subconscious style)', () => {
    expect(resolveGraphToolSurface({
      allowedToolNames: ['add_observational_memory', 'search_observations'],
    })).toEqual(['add_observational_memory', 'search_observations']);
  });

  it('drops non-string entries from a malformed allowlist', () => {
    expect(resolveGraphToolSurface({
      allowedToolNames: ['get_project_item', 42, null],
    })).toEqual(['get_project_item']);
  });
});

describe('buildGraphToolHandler', () => {
  const resolver = (impl: (name: string) => Promise<{ call: (args: Record<string, unknown>) => Promise<any> }>) =>
    impl as unknown as ToolResolver;

  it('refuses tools outside the graph-stamped surface without dispatching', async () => {
    const getTool = jest.fn<ToolResolver>();
    const handler = buildGraphToolHandler(['get_project_item'], getTool);

    const result = await handler({ tool: 'update_task', args: { id: 'x', status: 'done' } });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not in this agent\'s graph-stamped tool surface');
    expect(getTool).not.toHaveBeenCalled();
  });

  it('dispatches an allowlisted tool in-process and returns its result text', async () => {
    const call = jest.fn<(args: Record<string, unknown>) => Promise<any>>()
      .mockResolvedValue({ success: true, result: 'task payload' });
    const handler = buildGraphToolHandler(['get_project_item'], resolver(async () => ({ call })));

    const result = await handler({ tool: 'get_project_item', args: { id: 'abV0' } });

    expect(call).toHaveBeenCalledWith({ id: 'abV0' });
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toBe('task payload');
  });

  it('defaults missing args to an empty object', async () => {
    const call = jest.fn<(args: Record<string, unknown>) => Promise<any>>()
      .mockResolvedValue({ success: true, result: 'ok' });
    const handler = buildGraphToolHandler(['list_task_waits'], resolver(async () => ({ call })));

    await handler({ tool: 'list_task_waits' });

    expect(call).toHaveBeenCalledWith({});
  });

  it('surfaces worker failure as an MCP error result', async () => {
    const call = jest.fn<(args: Record<string, unknown>) => Promise<any>>()
      .mockResolvedValue({ success: false, error: 'PR not found' });
    const handler = buildGraphToolHandler(['github_get_pr'], resolver(async () => ({ call })));

    const result = await handler({ tool: 'github_get_pr', args: { owner: 'o', repo: 'r', pull_number: 1 } });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('PR not found');
  });

  it('maps a thrown resolver/worker error to an MCP error result', async () => {
    const handler = buildGraphToolHandler(
      ['github_get_pr'],
      resolver(async () => { throw new Error('registry unavailable'); }),
    );

    const result = await handler({ tool: 'github_get_pr' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('registry unavailable');
  });
});

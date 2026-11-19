// SPDX-License-Identifier: GPL-2.0-or-later
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

let Client: typeof import('../../../../../../services/sulla-workflows/src/toolClient.js').ScopedToolClient;
beforeAll(async() => {
  vi.stubEnv('SULLA_WORKFLOW_ROLE', 'runner');
  Client = (await import('../../../../../../services/sulla-workflows/src/toolClient.js')).ScopedToolClient;
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => vi.unstubAllEnvs());

describe('workflow tool category routing', () => {
  it('routes Dreamer to the memory scope authorized for its workflow', async() => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ result: { outcome: 'completed' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await expect(new Client('test-only-capability').call('dream_recent_memories', {})).resolves.toEqual({ outcome: 'completed' });
    expect(new URL(fetch.mock.calls[0][0]).pathname).toBe('/internal/tools/memory/dream_recent_memories');
  });
  it('preserves qualified names, explicit categories and the unknown-tool default', async() => {
    const paths: string[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string) => { paths.push(new URL(url).pathname); return Promise.resolve(new Response('{}')) }));
    const client = new Client('test-only-capability');
    await client.call('observation/write_file', {});
    await client.call('check_agent_jobs', {}, 'agents');
    await client.call('dream_recent_memories', {}, 'meta');
    await client.call('unknown_tool', {});
    expect(paths).toEqual(['/internal/tools/observation/write_file', '/internal/tools/agents/check_agent_jobs', '/internal/tools/meta/dream_recent_memories', '/internal/tools/meta/unknown_tool']);
  });
  it('still surfaces denied tool scopes instead of retrying a broader category', async() => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'tool is outside this run scope' }), { status: 403 }));
    vi.stubGlobal('fetch', fetch);
    await expect(new Client('test-only-capability').call('dream_recent_memories', {})).rejects.toThrow('tool is outside this run scope');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

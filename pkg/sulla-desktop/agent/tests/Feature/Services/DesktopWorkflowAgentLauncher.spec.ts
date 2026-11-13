import { beforeAll, describe, expect, it, vi } from 'vitest';

// risk: duplicate side effects — a Desktop workflow agent node must use the local Sulla agent orchestration API.
describe('Desktop workflow agent launcher', () => {
  let DesktopAgentLauncher: typeof import('../../../../../../services/sulla-workflows/src/toolClient.js').DesktopAgentLauncher;

  beforeAll(async() => {
    vi.stubEnv('SULLA_API_TOKEN', 'desktop-test-token-that-is-long-enough-for-the-service');
    ({ DesktopAgentLauncher } = await import('../../../../../../services/sulla-workflows/src/toolClient.js'));
  });

  it('spawns the requested local agent and returns its completed result', async() => {
    const call = vi.fn()
      .mockResolvedValueOnce({ jobId: 'job-1' })
      .mockResolvedValueOnce({ jobId: 'job-1', status: 'completed', result: { output: 'local result' }, threadId: 'thread-1' });
    const launcher = new DesktopAgentLauncher({ call } as any);

    await expect(launcher.run('research-agent', 'check the data', 'Research node')).resolves.toEqual({
      output: 'local result', threadId: 'thread-1',
    });
    expect(call).toHaveBeenNthCalledWith(1, 'spawn_agent', {
      tasks: [{ prompt: 'check the data', agentId: 'research-agent', label: 'Research node' }],
    });
    expect(call).toHaveBeenNthCalledWith(2, 'check_agent_jobs', { jobId: 'job-1' }, 'agents');
  });

  it('fails when the local agent orchestration reports a failed job', async() => {
    const call = vi.fn()
      .mockResolvedValueOnce({ jobId: 'job-2' })
      .mockResolvedValueOnce({ jobId: 'job-2', status: 'failed', error: 'worker failed' });
    const launcher = new DesktopAgentLauncher({ call } as any);

    await expect(launcher.run('research-agent', 'check the data', 'Research node')).rejects.toThrow('worker failed');
  });
});

import { AgentContainerCleanupOwner, retryContainerCleanup } from '../AgentContainerCleanup';

describe('agent container cleanup ownership', () => {
  test('recovers a transient cleanup failure within the bounded retry', async() => {
    let attempts = 0;
    await retryContainerCleanup(() => {
      attempts += 1;
      return attempts < 3
        ? Promise.reject(new Error('synthetic transient remove failure'))
        : Promise.resolve();
    }, { attempts: 4, baseDelayMs: 0 });
    expect(attempts).toBe(3);
  });

  test('reports permanent failure and retains retry ownership until recovery', async() => {
    const reports: string[] = [];
    let fail = true;
    const owner = new AgentContainerCleanupOwner(message => reports.push(message), 60_000);

    await expect(owner.run('container:synthetic', () => {
      return fail
        ? Promise.reject(new Error('synthetic permanent remove failure'))
        : Promise.resolve();
    })).rejects.toThrow('synthetic permanent remove failure');
    expect(owner.pendingCount).toBe(1);
    expect(reports.some(message => message.includes('remains pending'))).toBe(true);

    fail = false;
    await owner.retryPendingOnce();
    expect(owner.pendingCount).toBe(0);
    expect(reports.some(message => message.includes('recovered'))).toBe(true);
  });
});

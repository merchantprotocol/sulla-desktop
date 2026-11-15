// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getVersion: () => '0.0.0-test', isPackaged: false }, safeStorage: {} }));

const notReady = Object.assign(new Error('sulla-container-secrets exited 255: no stderr'), { exitCode: 255, stderr: '' });
const noSleep = () => Promise.resolve();

describe('container secrets right after the VM starts', () => {
  // risk: an agent job failed outright because it raced the VM boot
  it('waits out the boot race and then succeeds', async() => {
    const { retryWhileGuestStarting } = await import('../../../services/AgentContainerLauncher');
    const step = vi.fn().mockRejectedValueOnce(notReady).mockRejectedValueOnce(notReady).mockResolvedValue('ok');

    await expect(retryWhileGuestStarting(step, 5, 0, noSleep)).resolves.toBe('ok');
    expect(step).toHaveBeenCalledTimes(3);
  });

  it('does not retry a real failure inside the VM', async() => {
    const { retryWhileGuestStarting } = await import('../../../services/AgentContainerLauncher');
    const real = Object.assign(new Error('exited 73'), { exitCode: 73, stderr: '' });
    const step = vi.fn().mockRejectedValue(real);

    await expect(retryWhileGuestStarting(step, 5, 0, noSleep)).rejects.toBe(real);
    expect(step).toHaveBeenCalledTimes(1);
  });

  it('gives up after the last attempt so a dead VM still fails the job', async() => {
    const { retryWhileGuestStarting } = await import('../../../services/AgentContainerLauncher');
    const step = vi.fn().mockRejectedValue(notReady);

    await expect(retryWhileGuestStarting(step, 3, 0, noSleep)).rejects.toBe(notReady);
    expect(step).toHaveBeenCalledTimes(3);
  });
});

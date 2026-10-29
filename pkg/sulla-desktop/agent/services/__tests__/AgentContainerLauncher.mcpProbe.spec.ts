/** @jest-environment node */
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, jest, test } from '@jest/globals';

import { probeAgentMcpHost } from '../AgentContainerStartupRetry';

describe('agent container MCP probe retry', () => {
  test('succeeds after transient transport failures', async() => {
    const probe = jest.fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('sulla-runtime exec docker exec agent curl exited 255: no stderr'))
      .mockRejectedValueOnce(new Error('sulla-runtime exec docker exec agent curl exited 255: no stderr'))
      .mockResolvedValue();
    const repairRelay = jest.fn<() => Promise<void>>().mockResolvedValue();

    await expect(probeAgentMcpHost(probe, repairRelay, [0, 0, 0])).resolves.toBeUndefined();
    expect(probe).toHaveBeenCalledTimes(3);
    expect(repairRelay).not.toHaveBeenCalled();
  });

  test('reports the attempt window and last layer failure', async() => {
    const probe = jest.fn<() => Promise<void>>()
      .mockRejectedValue(new Error('sulla-runtime exec docker exec agent curl exited 255: no stderr'));

    await expect(probeAgentMcpHost(probe, async() => {}, [0, 0, 0]))
      .rejects.toThrow('graph MCP probe failed after 3 attempts: sulla-runtime exec docker exec agent curl exited 255: no stderr');
    expect(probe).toHaveBeenCalledTimes(3);
  });
});

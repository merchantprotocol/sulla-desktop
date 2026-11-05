// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { agentToolManifests } from '../../../../tools/agents/manifests';
import { ToolRegistry } from '../../../../tools/registry';

describe('check_agent_jobs registered manifest', () => {
  it('preserves view tree through registered-tool validation and reaches the worker', async() => {
    // risk: schema validation silently drops tree view and makes fleet hierarchy unreachable
    const registry = new ToolRegistry();
    registry.registerManifests(agentToolManifests.filter(manifest => manifest.name === 'check_agent_jobs'));
    const tool = await registry.createToolForCategory('agents', 'check_agent_jobs');
    tool.fleet = { list: async() => [{ jobId: 'manager', status: 'running', createdAt: '2026-11-05T12:00:00.000Z', finishedAt: null, parentThreadId: 'root', parentJobId: null, parentTaskIndex: null, rootThreadId: 'root', tasks: [] }] };
    tool.setState({ metadata: { threadId: 'root' } });
    const response = await tool.call({ view: 'tree' });
    expect(response.success).toBe(true);
    expect(JSON.parse(String(response.result))).toEqual({ count: 0, tasks: [] });
  });
});

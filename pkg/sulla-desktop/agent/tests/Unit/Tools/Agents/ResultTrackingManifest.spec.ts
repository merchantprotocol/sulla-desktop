// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';

import { agentToolManifests } from '../../../../tools/agents/manifests';
import { ToolRegistry } from '../../../../tools/registry';

describe('result tracking tool validation', () => {
  it('keeps exact result and decision references through the registered tool schemas', async() => {
    const registry = new ToolRegistry();
    registry.registerManifests(agentToolManifests.filter(manifest => ['spawn_agent', 'link_result'].includes(manifest.name)));
    const link = await registry.createToolForCategory('agents', 'link_result');
    const input = { jobId: 'next', taskIndex: 0, followUpOf: { jobId: 'old', taskIndex: 1 }, decisionIds: ['actual-question-id'] };
    expect(link.parseInput(input)).toMatchObject(input);
    const spawn = await registry.createToolForCategory('meta', 'spawn_agent');
    expect(spawn.parseInput({ tasks: [{ prompt: 'Continue the same work', followUpOf: input.followUpOf }] })).toMatchObject({ tasks: [{ followUpOf: input.followUpOf }] });
  });
});

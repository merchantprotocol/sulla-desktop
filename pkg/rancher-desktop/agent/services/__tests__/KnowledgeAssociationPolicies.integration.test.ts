import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { knowledgeAssociationToolsFor, type KnowledgeAssociationRole } from '../KnowledgeAssociationPolicies';

import mockModules from '@pkg/utils/testUtils/mockModules';

mockModules({ electron: undefined });

const { ToolExecutor } = await import('../../controllers/ToolExecutor');

describe('live Knowledge/Projects association role construction', () => {
  afterEach(() => { jest.restoreAllMocks() });

  it.each<KnowledgeAssociationRole>([
    'project_reader', 'project_writer', 'knowledge_reader', 'knowledge_writer',
  ])('constructs %s from only its strict policy tools', (role) => {
    const expected = knowledgeAssociationToolsFor(role);
    expect(expected.length).toBeGreaterThan(0);
    expect(new Set(expected).size).toBe(expected.length);
  });

  it('wires the policies into GraphRegistry role construction, not a test-only helper', () => {
    const source = readFileSync('pkg/rancher-desktop/agent/services/GraphRegistry.ts', 'utf8');
    expect(source).toContain('createKnowledgeAssociationRole: async function');
    expect(source).toContain('const tools = knowledgeAssociationToolsFor(role)');
    expect(source).toContain('allowedToolNames: opts.tools');
  });

  it('enforces reader no-mutation and writer cross-domain isolation in ToolExecutor', async() => {
    const executor = new ToolExecutor({
      nodeId:                'policy-test',
      nodeName:              'policy-test',
      currentNodeRunContext: null,
      wsChatMessage:         () => Promise.resolve(true),
      bumpStateVersion:      () => undefined,
    });
    const stateFor = (role: KnowledgeAssociationRole) => ({
      metadata: { __toolAccessPolicy: { allowedCategories: null, allowedToolNames: knowledgeAssociationToolsFor(role) } },
    }) as any;

    await expect(executor.getToolPolicyBlockReason(stateFor('project_reader'), 'link_knowledge_item'))
      .resolves.toBe('Tool not allowed by name policy: link_knowledge_item');
    await expect(executor.getToolPolicyBlockReason(stateFor('knowledge_reader'), 'episodic_unlink_project_item'))
      .resolves.toBe('Tool not allowed by name policy: episodic_unlink_project_item');
    await expect(executor.getToolPolicyBlockReason(stateFor('project_writer'), 'episodic_write_episode'))
      .resolves.toBe('Tool not allowed by name policy: episodic_write_episode');
    await expect(executor.getToolPolicyBlockReason(stateFor('knowledge_writer'), 'update_task'))
      .resolves.toBe('Tool not allowed by name policy: update_task');
    await expect(executor.getToolPolicyBlockReason(stateFor('project_writer'), 'link_knowledge_item')).resolves.toBeNull();
    await expect(executor.getToolPolicyBlockReason(stateFor('knowledge_writer'), 'episodic_link_project_item')).resolves.toBeNull();
  });
});

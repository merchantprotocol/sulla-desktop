import { afterEach, describe, expect, it, jest } from '@jest/globals';

import {
  KNOWLEDGE_ASSOCIATION_AGENT_ROLES,
  knowledgeAssociationToolsFor,
  type KnowledgeAssociationAgentId,
  type KnowledgeAssociationRole,
} from '../KnowledgeAssociationPolicies';

import mockModules from '@pkg/utils/testUtils/mockModules';

mockModules({
  electron:       undefined,
  'relaxed-json': { parse: JSON.parse },
});

jest.unstable_mockModule('../../database/models/SullaSettingsModel', () => ({
  SullaSettingsModel: {
    get: jest.fn((key: string, fallback: unknown) => Promise.resolve(
      key === 'modelMode' ? 'remote' : key === 'remoteModel' ? 'test-model' : fallback,
    )),
  },
}));

const { ToolExecutor } = await import('../../controllers/ToolExecutor');
const { GraphRegistry } = await import('../GraphRegistry');

describe('live Knowledge/Projects association role construction', () => {
  afterEach(() => { jest.restoreAllMocks() });

  it.each<KnowledgeAssociationRole>([
    'project_reader', 'project_writer', 'knowledge_reader', 'knowledge_writer',
  ])('constructs %s from only its strict policy tools', (role) => {
    const expected = knowledgeAssociationToolsFor(role);
    expect(expected.length).toBeGreaterThan(0);
    expect(new Set(expected).size).toBe(expected.length);
  });

  it('constructs live actors and enforces reader/writer isolation from their production state', async() => {
    const executor = new ToolExecutor({
      nodeId:                'policy-test',
      nodeName:              'policy-test',
      currentNodeRunContext: null,
      wsChatMessage:         () => Promise.resolve(true),
      bumpStateVersion:      () => undefined,
    });
    const stateFor = async(agentId: KnowledgeAssociationAgentId) => {
      const actor = await GraphRegistry.createNew(agentId);
      const expectedTools = knowledgeAssociationToolsFor(KNOWLEDGE_ASSOCIATION_AGENT_ROLES[agentId]);
      expect((actor.state.metadata as any).agent?.knowledgeAssociationRole)
        .toBe(KNOWLEDGE_ASSOCIATION_AGENT_ROLES[agentId]);
      expect((actor.state.metadata as any).allowedToolNames)
        .toEqual(expectedTools);
      expect((actor.state as any).llmTools.map((tool: any) => tool.function?.name ?? tool.name))
        .toEqual(expectedTools);
      return actor.state;
    };

    const projectReader = await stateFor('project-reader');
    const projectWriter = await stateFor('project-writer');
    const knowledgeReader = await stateFor('knowledge-base-reader');
    const knowledgeWriter = await stateFor('knowledge-base-writer');

    await expect(executor.getToolPolicyBlockReason(projectReader, 'link_knowledge_item'))
      .resolves.toBe('Tool not allowed by name policy: link_knowledge_item');
    await expect(executor.getToolPolicyBlockReason(knowledgeReader, 'episodic_unlink_project_item'))
      .resolves.toBe('Tool not allowed by name policy: episodic_unlink_project_item');
    await expect(executor.getToolPolicyBlockReason(projectWriter, 'episodic_write_episode'))
      .resolves.toBe('Tool not allowed by name policy: episodic_write_episode');
    await expect(executor.getToolPolicyBlockReason(knowledgeWriter, 'update_task'))
      .resolves.toBe('Tool not allowed by name policy: update_task');
    await expect(executor.getToolPolicyBlockReason(projectWriter, 'link_knowledge_item')).resolves.toBeNull();
    await expect(executor.getToolPolicyBlockReason(knowledgeWriter, 'episodic_link_project_item')).resolves.toBeNull();
  });
});

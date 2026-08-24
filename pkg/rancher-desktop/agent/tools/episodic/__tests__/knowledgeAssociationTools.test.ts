import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { WorkItemKnowledgeModel } from '../../../database/models/WorkItemKnowledgeModel';
import { KNOWLEDGE_ASSOCIATION_TOOL_POLICIES } from '../../../services/KnowledgeAssociationPolicies';
import { LinkKnowledgeItemWorker } from '../../project/link_knowledge_item';
import { projectToolManifests } from '../../project/manifests';
import { LinkProjectItemWorker } from '../link_project_item';
import { episodicToolManifests } from '../manifests';

describe('knowledge association tool adapters and policy', () => {
  afterEach(() => { jest.restoreAllMocks() });

  it('routes writes from both namespaces through the same shared model', async() => {
    const link = jest.spyOn(WorkItemKnowledgeModel, 'link').mockResolvedValue({ id: 'same-link' } as any);
    const input = { item_kind: 'task', item_id: 'task-1', knowledge_node_id: 'node-1' };
    await (new LinkKnowledgeItemWorker() as any)._validatedCall(input);
    await (new LinkProjectItemWorker() as any)._validatedCall(input);
    expect(link).toHaveBeenCalledTimes(2);
    expect(link.mock.calls[0][0]).toEqual(link.mock.calls[1][0]);
  });

  it('keeps reader roles read-only and writers narrow', () => {
    expect(KNOWLEDGE_ASSOCIATION_TOOL_POLICIES.project_reader).toEqual(expect.arrayContaining(['list_linked_knowledge']));
    expect(KNOWLEDGE_ASSOCIATION_TOOL_POLICIES.knowledge_reader).toEqual(expect.arrayContaining(['episodic_recall']));
    for (const reader of [
      KNOWLEDGE_ASSOCIATION_TOOL_POLICIES.project_reader,
      KNOWLEDGE_ASSOCIATION_TOOL_POLICIES.knowledge_reader,
    ]) {
      expect(reader.some(name => /link_|unlink_|update_|create_|archive_/.test(name))).toBe(false);
    }
    expect(KNOWLEDGE_ASSOCIATION_TOOL_POLICIES.project_writer).not.toContain('episodic_write_episode');
    expect(KNOWLEDGE_ASSOCIATION_TOOL_POLICIES.knowledge_writer).not.toContain('update_task');
    expect(KNOWLEDGE_ASSOCIATION_TOOL_POLICIES.knowledge_writer).not.toEqual(expect.arrayContaining(['exec', 'read_file', 'browser_tab', 'git_push']));
  });

  it('registers read and mutation operations correctly in both namespaces', () => {
    const projectList = projectToolManifests.find(tool => tool.name === 'list_linked_knowledge');
    const projectLink = projectToolManifests.find(tool => tool.name === 'link_knowledge_item');
    const knowledgeList = episodicToolManifests.find(tool => tool.name === 'episodic_list_linked_project_items');
    const knowledgeLink = episodicToolManifests.find(tool => tool.name === 'episodic_link_project_item');
    expect(projectList?.operationTypes).toEqual(['read']);
    expect(knowledgeList?.operationTypes).toEqual(['read']);
    expect(projectLink?.operationTypes).toEqual(['create', 'update']);
    expect(knowledgeLink?.operationTypes).toEqual(['create', 'update']);
  });
});

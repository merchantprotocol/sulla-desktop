import { describe, expect, it, jest } from '@jest/globals';

import mockModules from '@pkg/utils/testUtils/mockModules';

const invoke = jest.fn((_channel: string, _input: any) => Promise.resolve([]));
mockModules({ '@pkg/utils/ipcRenderer': { ipcRenderer: { invoke } } });

const runtime = await import('../knowledgeAssociationRuntime');

describe('renderer Knowledge/Projects association runtime', () => {
  it('routes both read directions through their IPC contracts', async() => {
    await runtime.listKnowledgeForItem({ itemKind: 'task', itemId: 't1', includeInherited: true });
    await runtime.listWorkForKnowledge({ knowledgeNodeId: 'n1' });
    await runtime.searchKnowledgeNodes({ query: 'decision' });
    expect(invoke).toHaveBeenNthCalledWith(1, 'work-items:knowledge-list', expect.objectContaining({ itemId: 't1' }));
    expect(invoke).toHaveBeenNthCalledWith(2, 'knowledge:work-list', { knowledgeNodeId: 'n1' });
    expect(invoke).toHaveBeenNthCalledWith(3, 'knowledge:nodes-search', { query: 'decision' });
  });

  it('routes attach and detach through the shared runtime contract', async() => {
    const input = { itemKind: 'project' as const, itemId: 'p1', knowledgeNodeId: 'n1', relationType: 'evidence' };
    await runtime.linkKnowledgeItem(input);
    await runtime.unlinkKnowledgeItem(input);
    expect(invoke).toHaveBeenCalledWith('work-items:knowledge-link', input);
    expect(invoke).toHaveBeenCalledWith('work-items:knowledge-unlink', input);
  });
});

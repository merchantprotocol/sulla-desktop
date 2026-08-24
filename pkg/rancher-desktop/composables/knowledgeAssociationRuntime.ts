import type { KnowledgeNodeRecord, KnowledgeSearchOptions } from '@pkg/agent/database/models/KnowledgeGraphModel';
import type {
  KnowledgeLinkInput, KnowledgeWorkItemKind, LinkedKnowledgeRecord, LinkedWorkItemRecord,
} from '@pkg/agent/database/models/WorkItemKnowledgeModel';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

export function searchKnowledgeNodes(input: KnowledgeSearchOptions): Promise<KnowledgeNodeRecord[]> {
  return ipcRenderer.invoke('knowledge:nodes-search', input);
}

export function listKnowledgeForItem(input: {
  itemKind: KnowledgeWorkItemKind; itemId: string; includeInherited?: boolean; includeArchived?: boolean; limit?: number;
}): Promise<LinkedKnowledgeRecord[]> {
  return ipcRenderer.invoke('work-items:knowledge-list', input);
}

export function listWorkForKnowledge(input: {
  knowledgeNodeId: string; includeArchived?: boolean; limit?: number;
}): Promise<LinkedWorkItemRecord[]> {
  return ipcRenderer.invoke('knowledge:work-list', input);
}

export function linkKnowledgeItem(input: KnowledgeLinkInput): Promise<any> {
  return ipcRenderer.invoke('work-items:knowledge-link', input);
}

export function unlinkKnowledgeItem(input: KnowledgeLinkInput): Promise<boolean> {
  return ipcRenderer.invoke('work-items:knowledge-unlink', input);
}

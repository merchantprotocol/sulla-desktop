import {
  AgentDefinitionModel,
  type AgentDefinition,
  type AgentDefinitionInput,
  type AgentDefinitionPatch,
  type AgentDefinitionStatus,
} from '../database/models/AgentDefinitionModel';

/** Runtime-facing facade for database-backed agent definitions. */
export class AgentDefinitionService {
  get(id: string): Promise<AgentDefinition | null> { return AgentDefinitionModel.get(id) }
  findBySlug(slug: string): Promise<AgentDefinition | null> { return AgentDefinitionModel.findBySlug(slug) }
  list(status?: AgentDefinitionStatus): Promise<AgentDefinition[]> { return AgentDefinitionModel.list(status) }
  create(input: AgentDefinitionInput): Promise<AgentDefinition> { return AgentDefinitionModel.create(input) }
  update(id: string, patch: AgentDefinitionPatch): Promise<AgentDefinition | null> { return AgentDefinitionModel.update(id, patch) }
  setStatus(id: string, status: AgentDefinitionStatus): Promise<AgentDefinition | null> { return AgentDefinitionModel.setStatus(id, status) }
  delete(id: string): Promise<boolean> { return AgentDefinitionModel.delete(id) }
}

export const agentDefinitionService = new AgentDefinitionService();

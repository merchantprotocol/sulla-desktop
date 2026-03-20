// Agent System - Main exports
// Flow: SensoryInput → ContextDetector → ConversationThread (Graph) → AgentNode

export * from './types';
export { Sensory, getSensory } from './SensoryInput';
export { Graph } from './nodes/Graph';

// Graph Nodes
export { BaseNode } from './nodes/BaseNode';

// Services
export { getSchedulerService, SchedulerService } from './services/SchedulerService';
export { getHeartbeatService, HeartbeatService } from './services/HeartbeatService';
export { FrontendGraphWebSocketService } from './services/FrontendGraphWebSocketService';
export { getBackendGraphWebSocketService, BackendGraphWebSocketService } from './services/BackendGraphWebSocketService';
export { getIntegrationService, IntegrationService } from './services/IntegrationService';
export { getExtensionService, ExtensionService, LocalExtensionMetadata } from './services/ExtensionService';
export type { MarketplaceEntry, InstalledExtension } from './services/ExtensionService';

// Models
export { AgentPersonaService } from './database/models/AgentPersonaModel';
export type {
  PersonaTemplateId,
  PersonaStatus,
  PersonaEmotion,
  AgentPersonaState,
  PersonaAssetType,
  PersonaSidebarAsset,
} from './database/models/AgentPersonaModel';

// Registry
export { AgentPersonaRegistry, getAgentPersonaRegistry } from './database/registry/AgentPersonaRegistry';
export type { ChatMessage, AgentRegistryEntry } from './database/registry/AgentPersonaRegistry';

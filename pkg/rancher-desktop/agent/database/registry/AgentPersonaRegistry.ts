// AgentPersonaRegistry.ts
import { computed, reactive } from 'vue';
import type { PersonaEmotion, PersonaStatus, PersonaTemplateId } from '@pkg/agent';
import { AgentPersonaService } from '@pkg/agent';


export type ChatMessage = {
  id: string;
  channelId: string;
  role: 'user' | 'assistant' | 'error' | 'system';
  content: string;
  kind?: 'text' | 'tool' | 'planner' | 'critic' | 'progress' | 'error' | 'thinking' | 'channel_message';
  image?: {
    dataUrl: string;
    alt?: string;
    contentType?: string;
    path?: string;
  };
  toolCard?: {
    toolRunId: string;
    toolName: string;
    status: 'running' | 'success' | 'failed';
    args?: Record<string, unknown>;
    result?: unknown;
    error?: string | null;
  };
  channelMeta?: {
    senderId: string;
    senderChannel: string;
  };
};

export type AgentRegistryEntry = {
  isRunning: boolean;

  agentId: string;
  agentName: string;

  templateId: PersonaTemplateId;
  emotion: PersonaEmotion;

  status: PersonaStatus;
  tokensPerSecond: number;
  totalTokensUsed: number;
  temperature: number;

  messages: ChatMessage[];
  loading: boolean;
};

export class AgentPersonaRegistry {
  private readonly backgroundAgentId = 'heartbeat';
  private readonly activeAgentListeners = new Set<(agent: AgentRegistryEntry | undefined) => void>();

  private readonly personaServices = new Map<string, AgentPersonaService>();

  readonly state = reactive<{ agents: AgentRegistryEntry[]; activeAgentId: string }>({
    agents: [
      {
        isRunning: true,
        agentId: 'sulla-desktop',
        agentName: 'Sulla',
        templateId: 'glass-core',
        emotion: 'calm',
        status: 'online',
        tokensPerSecond: 847,
        totalTokensUsed: 0,
        temperature: 0.7,
        messages: [],
        loading: false,
      },
      {
        isRunning: true,
        agentId: 'heartbeat',
        agentName: 'Heartbeat',
        templateId: 'terminal',
        emotion: 'focus',
        status: 'idle',
        tokensPerSecond: 120,
        totalTokensUsed: 0,
        temperature: 0.2,
        messages: [],
        loading: false,
      },
    ],
    activeAgentId: 'sulla-desktop',
  });

  constructor() {
    // New — no need to call startListening anymore
    this.state.agents.forEach(agent => {
      this.getOrCreatePersonaService(agent.agentId);  // constructor already connects
    });
  }

  // Kept for full backward compatibility with any other code
  getOrCreatePersonaService(agentId: string): AgentPersonaService {
    if (!this.personaServices.has(agentId)) {
      const agentData = this.state.agents.find(a => a.agentId === agentId);
      const service = new AgentPersonaService(this, agentData);
      this.personaServices.set(agentId, service);
    }
    return this.personaServices.get(agentId)!;
  }

  getPersonaService(agentId: string): AgentPersonaService | undefined {
    return this.personaServices.get(agentId);
  }

  getActivePersonaService(): AgentPersonaService | undefined {
    return this.getPersonaService(this.state.activeAgentId);
  }

  readonly visibleAgents = computed(() => this.state.agents.filter(a => a.isRunning));
  readonly activeAgent = computed(() => 
    this.state.agents.find(a => a.agentId === this.state.activeAgentId) || this.state.agents[0]
  );

  setActiveAgent(agentId: string): void {
    if (this.state.agents.some(a => a.agentId === agentId)) {
      this.state.activeAgentId = agentId;
      this.notifyActiveAgentListeners();
    }
  }

  onActiveAgentChange(listener: (agent: AgentRegistryEntry | undefined) => void): () => void {
    this.activeAgentListeners.add(listener);
    listener(this.activeAgent.value);
    return () => this.activeAgentListeners.delete(listener);
  }

  private notifyActiveAgentListeners(): void {
    const agent = this.activeAgent.value;
    this.activeAgentListeners.forEach(l => { try { l(agent); } catch {} });
  }

  setAgentRunning(agentId: string, isRunning: boolean): void {
    const agent = this.state.agents.find(a => a.agentId === agentId);
    if (!agent) {
      return;
    }
    agent.isRunning = isRunning;

    if (!isRunning && this.state.activeAgentId === agentId) {
      const next = this.visibleAgents.value[0];
      this.state.activeAgentId = next?.agentId || '';
      this.notifyActiveAgentListeners();
      return;
    }

    if (isRunning && this.state.activeAgentId === '') {
      this.state.activeAgentId = agentId;
      this.notifyActiveAgentListeners();
    }
  }

  pushMessage(agentId: string, message: ChatMessage): void {
    const agent = this.state.agents.find(a => a.agentId === agentId);
    if (agent) {
      agent.messages.push(message);
    }
  }

  setLoading(agentId: string, loading: boolean): void {
    const agent = this.state.agents.find(a => a.agentId === agentId);
    if (agent) {
      agent.loading = loading;
    }
  }

  updateMessage(agentId: string, messageId: string, update: Partial<ChatMessage>): boolean {
    const agent = this.state.agents.find(a => a.agentId === agentId);
    if (!agent) return false;
    const idx = agent.messages.findIndex(m => m.id === messageId);
    if (idx < 0) return false;
    agent.messages[idx] = { ...agent.messages[idx], ...update };
    return true;
  }

  findMessageIndex(agentId: string, messageId: string): number {
    const agent = this.state.agents.find(a => a.agentId === agentId);
    return agent?.messages.findIndex(m => m.id === messageId) ?? -1;
  }

  getMessage(agentId: string, index: number): ChatMessage | undefined {
    const agent = this.state.agents.find(a => a.agentId === agentId);
    return agent?.messages[index];
  }

  setMessage(agentId: string, index: number, message: ChatMessage): void {
    const agent = this.state.agents.find(a => a.agentId === agentId);
    if (agent && index >= 0 && index < agent.messages.length) {
      agent.messages[index] = message;
    }
  }

  isLoading(agentId: string): boolean {
    const agent = this.state.agents.find(a => a.agentId === agentId);
    return agent?.loading ?? false;
  }

  setHeartbeatEnabled(enabled: boolean): void {
    this.setAgentRunning(this.backgroundAgentId, enabled);
  }
  
  upsertAgent(agent: AgentRegistryEntry): void {
    const idx = this.state.agents.findIndex(a => a.agentId === agent.agentId);
    if (idx >= 0) {
      this.state.agents[idx] = agent;
      return;
    }
    this.state.agents.push({
      ...agent,
      totalTokensUsed: agent.totalTokensUsed ?? 0
    });
  }

  removeAgent(agentId: string): void {
    const idx = this.state.agents.findIndex(a => a.agentId === agentId);
    if (idx < 0) {
      return;
    }
    this.state.agents.splice(idx, 1);
    if (this.state.activeAgentId === agentId) {
      this.state.activeAgentId = this.state.agents[0]?.agentId || '';
      this.notifyActiveAgentListeners();
    }
  }
}

let instance: AgentPersonaRegistry | null = null;
export function getAgentPersonaRegistry(): AgentPersonaRegistry {
  if (!instance) instance = new AgentPersonaRegistry();
  return instance;
}
// AgentPersonaRegistry.ts
import { computed, reactive } from 'vue';

import type { PersonaEmotion, PersonaStatus, PersonaTemplateId } from '@pkg/agent';
import { AgentPersonaService } from '@pkg/agent';

export interface ChatMessage {
  id:        string;
  channelId: string;
  threadId?: string;
  role:      'user' | 'assistant' | 'error' | 'system';
  content:   string;
  kind?:     'text' | 'tool' | 'planner' | 'critic' | 'progress' | 'error' | 'thinking' | 'channel_message' | 'workflow_node' | 'workflow_document' | 'html' | 'sub_agent_activity' | 'voice_interim' | 'streaming' | 'speak' | 'citation';
  image?: {
    dataUrl:      string;
    alt?:         string;
    contentType?: string;
    path?:        string;
  };
  toolCard?: {
    toolRunId:     string;
    toolName:      string;
    description?:  string;
    status:        'running' | 'success' | 'failed';
    args?:         Record<string, unknown>;
    result?:       unknown;
    error?:        string | null;
    /** Human-friendly display fields populated by toolCardFormatters */
    label?:        string;
    summary?:      string;
    input?:        string;
    output?:       string;
    outputFormat?: 'text' | 'code' | 'url' | 'json';
  };
  channelMeta?: {
    senderId:      string;
    senderChannel: string;
  };
  workflowNode?: {
    workflowRunId: string;
    nodeId:        string;
    nodeLabel:     string;
    status:        'running' | 'completed' | 'failed' | 'waiting';
    prompt?:       string;
    output?:       string;
    error?:        string;
    nodeIndex:     number;
    totalNodes:    number;
  };
  subAgentActivity?: {
    nodeId:          string;
    nodeLabel:       string;
    status:          'running' | 'completed' | 'failed' | 'blocked';
    thinkingLines:   string[];
    latestThinking?: string;
    output?:         string;
    error?:          string;
  };
  /** Source list surfaced as a CitationRow below the reply. Populated by the
   *  CitationExtractor when the model emits a `<citations>` block. */
  citations?: {
    num:     number;
    title:   string;
    origin:  string;
    url?:    string;
  }[];
  /**
   * Full routine document published by the `workflow/display` tool to
   * render the workflow in the chat artifact sidebar. The shape mirrors
   * routine.yaml exactly — same field names, same nesting — so the
   * frontend renderer consumes it with zero mapping.
   */
  workflowDocument?: {
    slug:         string;
    id?:          string;
    name?:        string;
    description?: string;
    _status?:     'draft' | 'production' | 'archive';
    viewport?:    { x: number; y: number; zoom: number };
    nodes:        Array<{
      id:       string;
      type:     string;
      position: { x: number; y: number };
      data:     {
        subtype:  string;
        category: string;
        label:    string;
        config?:  Record<string, unknown>;
      };
    }>;
    edges: Array<{
      id:            string;
      source:        string;
      target:        string;
      sourceHandle?: string | null;
      targetHandle?: string | null;
      label?:        string;
      animated?:     boolean;
    }>;
  };
}

export interface AgentRegistryEntry {
  isRunning: boolean;

  agentId:   string;
  agentName: string;

  templateId: PersonaTemplateId;
  emotion:    PersonaEmotion;

  status:          PersonaStatus;
  tokensPerSecond: number;
  totalTokensUsed: number;
  temperature:     number;

  messages: ChatMessage[];
  loading:  boolean;
}

export class AgentPersonaRegistry {
  private readonly backgroundAgentId = 'heartbeat';
  private readonly activeAgentListeners = new Set<(agent: AgentRegistryEntry | undefined) => void>();

  private readonly personaServices = new Map<string, AgentPersonaService>();

  readonly state = reactive<{ agents: AgentRegistryEntry[]; activeAgentId: string }>({
    agents: [
      {
        isRunning:       true,
        agentId:         'sulla-desktop',
        agentName:       'Sulla',
        templateId:      'glass-core',
        emotion:         'calm',
        status:          'online',
        tokensPerSecond: 847,
        totalTokensUsed: 0,
        temperature:     0.7,
        messages:        [],
        loading:         false,
      },
      {
        isRunning:       true,
        agentId:         'heartbeat',
        agentName:       'Heartbeat',
        templateId:      'terminal',
        emotion:         'focus',
        status:          'idle',
        tokensPerSecond: 120,
        totalTokensUsed: 0,
        temperature:     0.2,
        messages:        [],
        loading:         false,
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

  /**
   * Get or create a persona service.
   * @param agentId  The WebSocket channel / agent ID (e.g. 'sulla-desktop')
   * @param tabId    Optional tab identifier. When provided a separate persona
   *                 instance is created per tab so each tab has its own messages,
   *                 threadId, and localStorage scope while sharing the same WS channel.
   */
  getOrCreatePersonaService(agentId: string, tabId?: string): AgentPersonaService {
    const key = tabId ? `${ agentId }_${ tabId }` : agentId;
    if (!this.personaServices.has(key)) {
      const agentData = this.state.agents.find(a => a.agentId === agentId);
      const service = new AgentPersonaService(this, agentData, agentId, tabId);
      this.personaServices.set(key, service);
    }
    return this.personaServices.get(key)!;
  }

  getPersonaService(agentId: string): AgentPersonaService | undefined {
    return this.personaServices.get(agentId);
  }

  getActivePersonaService(): AgentPersonaService | undefined {
    return this.getPersonaService(this.state.activeAgentId);
  }

  readonly visibleAgents = computed(() => this.state.agents.filter(a => a.isRunning));
  readonly activeAgent = computed(() =>
    this.state.agents.find(a => a.agentId === this.state.activeAgentId) || this.state.agents[0],
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
    this.activeAgentListeners.forEach(l => { try { l(agent) } catch {} });
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
      totalTokensUsed: agent.totalTokensUsed ?? 0,
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

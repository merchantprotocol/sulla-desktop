import { Graph, createHeartbeatGraph, createAgentGraph, BaseThreadState, AgentGraphState, GeneralGraphState } from '../nodes/Graph';
import type { HeartbeatThreadState } from '../nodes/HeartbeatNode';
// Back-compat re-export
export type { HeartbeatThreadState as OverlordThreadState } from '../nodes/HeartbeatNode';
import { SullaSettingsModel } from '../database/models/SullaSettingsModel';
import { getCurrentModel, getCurrentMode } from '../languagemodels';

// Side-effect: ensure tool manifests are registered before any graph runs
import '../tools/manifests';

const registry = new Map<string, {
  graph: Graph<any>;
  state: BaseThreadState;
}>();

export const GraphRegistry = {
  /**
   * Get existing graph for thread, or create new if not found.
   */
  get(threadId: string): {
    graph: Graph<any>;
    state: BaseThreadState;
  } | null {
    return registry.get(threadId) ?? null;
  },

  /**
   * Create a brand new graph + state (always fresh threadId).
   * Use when user explicitly wants "New Conversation".
   */
  createNew: async function(wsChannel: string): Promise<{
    graph: Graph<any>;
    state: BaseThreadState;
    threadId: string;
  }> {
    const threadId = nextThreadId();
    const graph = createAgentGraph();
    const state = await buildAgentState(wsChannel, threadId);

    registry.set(threadId, { graph, state });
    return { graph, state, threadId };
  },

  /**
   * Get or create Heartbeat graph (formerly Overlord).
   */
  getOrCreateOverlordGraph: async function(wsChannel: string, prompt?: string): Promise<{
    graph: Graph<HeartbeatThreadState>;
    state: HeartbeatThreadState;
  }> {
    if (registry.has(wsChannel)) {
      return Promise.resolve(registry.get(wsChannel) as any);
    }

    const graph = createHeartbeatGraph();
    const state = await buildHeartbeatState(wsChannel, prompt ?? '');

    registry.set(wsChannel, { graph, state });
    return { graph, state };
  },

  /**
   * Get or create AgentGraph — the standard graph for all tasks.
   */
  getOrCreate: async function(wsChannel: string, threadId: string): Promise<{
    graph: Graph<AgentGraphState>;
    state: AgentGraphState;
  }> {
    if (registry.has(threadId)) {
      return Promise.resolve(registry.get(threadId)!);
    }

    const graph = createAgentGraph();
    const state = await buildAgentState(wsChannel, threadId);

    registry.set(threadId, { graph, state });
    return { graph, state };
  },

  // Aliases — all point to AgentGraph now
  getOrCreateSkillGraph: async function(wsChannel: string, threadId: string) {
    return this.getOrCreate(wsChannel, threadId);
  },

  getOrCreateAgentGraph: async function(wsChannel: string, threadId: string) {
    return this.getOrCreate(wsChannel, threadId);
  },

  getOrCreateGeneralGraph: async function(wsChannel: string, threadId: string) {
    return this.getOrCreate(wsChannel, threadId);
  },

  delete(threadId: string): void {
    registry.delete(threadId);
  },

  clearAll(): void {
    registry.clear();
  },

  updateRuntimeFlags(threadId: string, flags: { n8nLiveEventsEnabled?: boolean }): boolean {
    const record = registry.get(threadId);
    if (!record) {
      return false;
    }

    if (typeof flags.n8nLiveEventsEnabled === 'boolean') {
      (record.state.metadata as any).n8nLiveEventsEnabled = flags.n8nLiveEventsEnabled;
    }

    return true;
  },

  updateRuntimeFlagsByStateThreadId(threadId: string, flags: { n8nLiveEventsEnabled?: boolean }): number {
    let updatedCount = 0;

    for (const record of registry.values()) {
      const stateThreadId = String((record.state.metadata as any)?.threadId || '').trim();
      if (!stateThreadId || stateThreadId !== threadId) {
        continue;
      }

      if (typeof flags.n8nLiveEventsEnabled === 'boolean') {
        (record.state.metadata as any).n8nLiveEventsEnabled = flags.n8nLiveEventsEnabled;
      }

      updatedCount += 1;
    }

    return updatedCount;
  }
};

let threadCounter = 0;
let messageCounter = 0;

export function nextThreadId(): string {
  return `thread_${Date.now()}_${++threadCounter}`;
}

export function nextMessageId(): string {
  return `msg_${Date.now()}_${++messageCounter}`;
}

async function buildHeartbeatState(wsChannel: string, prompt: string): Promise<HeartbeatThreadState> {
  const heartbeatProvider = await SullaSettingsModel.get('heartbeatProvider', 'default');

  // Resolve provider to model/local flags
  let llmModel: string;
  let llmLocal: boolean;

  if (heartbeatProvider === 'default' || heartbeatProvider === 'ollama') {
    // Use primary provider resolution for 'default', or local for 'ollama'
    if (heartbeatProvider === 'default') {
      llmModel = await getCurrentModel();
      llmLocal = (await getCurrentMode()) === 'local';
    } else {
      llmModel = await SullaSettingsModel.get('sullaModel', '');
      llmLocal = true;
    }
  } else {
    // Remote provider — get model from integration form values
    llmLocal = false;
    try {
      const { getIntegrationService } = await import('./IntegrationService');
      const integrationService = getIntegrationService();
      const values = await integrationService.getFormValues(heartbeatProvider);
      const modelVal = values.find((v: { property: string; value: string }) => v.property === 'model');
      llmModel = modelVal?.value || '';
    } catch {
      llmModel = await SullaSettingsModel.get('remoteModel', '');
    }
  }

  const now = Date.now();
  const threadId = `heartbeat_${ now }`;

  const state: HeartbeatThreadState = {
    messages: [{
      role: 'user',
      content: prompt,
      metadata: { source: 'heartbeat' },
    }],
    metadata: {
      action: 'use_tools',
      threadId,
      wsChannel,
      cycleComplete: false,
      waitingForUser: false,
      llmModel,
      llmLocal,
      options: {},
      currentNodeId: 'input_handler',
      consecutiveSameNode: 0,
      iterations: 0,
      revisionCount: 0,
      maxIterationsReached: false,
      memory: {
        knowledgeBaseContext: '',
        chatSummariesContext: '',
      },
      subGraph: {
        state: 'completed',
        name: 'hierarchical',
        prompt: '',
        response: '',
      },
      finalSummary: '',
      finalState: 'running',
      n8nLiveEventsEnabled: false,
      returnTo: null,

      // Heartbeat-specific fields
      activeProjects: '',
      availableSkills: '',
      heartbeatCycleCount: 0,
      heartbeatMaxCycles: 10,
      heartbeatStatus: 'idle',
      heartbeatLastCycleSummary: '',
      currentFocus: '',
      focusReason: '',

      // Environmental context (loaded each cycle by HeartbeatNode)
      agentsContext: '',
    },
  };

  return state;
}


async function buildAgentState(wsChannel: string, threadId?: string): Promise<AgentGraphState> {
  const id = threadId ?? nextThreadId();

  const mode = await SullaSettingsModel.get('modelMode', 'local');
  const llmModel = mode === 'remote'
    ? await SullaSettingsModel.get('remoteModel', '')
    : await SullaSettingsModel.get('sullaModel', '');
  const llmLocal = mode === 'local';

  return {
    messages: [],
    metadata: {
      action: 'direct_answer',
      threadId: id,
      wsChannel: wsChannel,

      cycleComplete: false,
      waitingForUser: false,

      llmModel,
      llmLocal,
      options: { abort: undefined },
      currentNodeId: 'input_handler',
      consecutiveSameNode: 0,
      iterations: 0,
      revisionCount: 0,
      maxIterationsReached: false,
      memory: {
        knowledgeBaseContext: '',
        chatSummariesContext: ''
      },
      subGraph: {
        state: 'completed',
        name: 'hierarchical',
        prompt: '',
        response: ''
      },
      finalSummary: '',
      finalState: 'running',
      n8nLiveEventsEnabled: false,
      returnTo: null,

      agent: undefined,
      agentLoopCount: 0
    }
  };
}

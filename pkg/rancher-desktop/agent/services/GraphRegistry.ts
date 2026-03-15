import { Graph, createHeartbeatGraph, createAgentGraph, BaseThreadState, AgentGraphState, GeneralGraphState } from '../nodes/Graph';
import type { HeartbeatThreadState } from '../nodes/HeartbeatNode';
import { SullaSettingsModel } from '../database/models/SullaSettingsModel';
import { getCurrentModel, getCurrentMode } from '../languagemodels';
import { resolveSullaAgentsDir } from '../utils/sullaPaths';
import * as fs from 'fs';
import * as path from 'path';

// Side-effect: ensure tool manifests are registered before any graph runs
import '../tools/manifests';
// Back-compat re-export
export type { HeartbeatThreadState as OverlordThreadState } from '../nodes/HeartbeatNode';

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
  createNew: async function(wsChannel: string, options?: { isTrustedUser?: 'trusted' | 'untrusted' | 'verify'; userVisibleBrowser?: boolean }): Promise<{
    graph:    Graph<any>;
    state:    BaseThreadState;
    threadId: string;
  }> {
    const threadId = nextThreadId();
    const graph = createAgentGraph();
    const state = await buildAgentState(wsChannel, threadId, options);

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
   * @param options Optional graph options that configure prompt directives, tool blocking, etc.
   */
  getOrCreate: async function(wsChannel: string, threadId: string, options?: { isTrustedUser?: 'trusted' | 'untrusted' | 'verify'; userVisibleBrowser?: boolean }): Promise<{
    graph: Graph<AgentGraphState>;
    state: AgentGraphState;
  }> {
    if (registry.has(threadId)) {
      console.log(`[GraphRegistry] getOrCreate() — cache HIT for threadId="${ threadId }"`);
      return Promise.resolve(registry.get(threadId)!);
    }

    console.log(`[GraphRegistry] getOrCreate() — cache MISS, creating new graph for agentId="${ wsChannel }", threadId="${ threadId }"`);
    const graph = createAgentGraph();
    console.log(`[GraphRegistry] getOrCreate() — agent graph created, building state...`);
    const state = await buildAgentState(wsChannel, threadId, options);
    console.log(`[GraphRegistry] getOrCreate() — state built: model="${ state.metadata.llmModel }", local=${ state.metadata.llmLocal }, agentName="${ state.metadata.agent?.name || '(none)' }"`);

    registry.set(threadId, { graph, state });
    return { graph, state };
  },

  // Aliases — all point to AgentGraph now
  getOrCreateSkillGraph: async function(wsChannel: string, threadId: string, options?: { isTrustedUser?: 'trusted' | 'untrusted' | 'verify'; userVisibleBrowser?: boolean }) {
    return this.getOrCreate(wsChannel, threadId, options);
  },

  getOrCreateAgentGraph: async function(wsChannel: string, threadId: string, options?: { isTrustedUser?: 'trusted' | 'untrusted' | 'verify'; userVisibleBrowser?: boolean }) {
    return this.getOrCreate(wsChannel, threadId, options);
  },

  getOrCreateGeneralGraph: async function(wsChannel: string, threadId: string, options?: { isTrustedUser?: 'trusted' | 'untrusted' | 'verify'; userVisibleBrowser?: boolean }) {
    return this.getOrCreate(wsChannel, threadId, options);
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
  },
};

const DEFAULT_AGENT_FALLBACK = 'chat-controller';

/**
 * Resolve the default agent ID from settings, falling back to 'chat-controller'.
 */
export async function getDefaultAgentId(): Promise<string> {
  console.log(`[GraphRegistry] getDefaultAgentId() — resolving...`);
  const id = await SullaSettingsModel.get('defaultAgentId', '');
  if (id) {
    console.log(`[GraphRegistry] getDefaultAgentId() — found setting: "${ id }"`);
    return id;
  }

  // If no setting yet, check if chat-controller exists
  const agentDir = path.join(resolveSullaAgentsDir(), DEFAULT_AGENT_FALLBACK);
  if (fs.existsSync(agentDir)) {
    console.log(`[GraphRegistry] getDefaultAgentId() — no setting, using fallback dir: "${ DEFAULT_AGENT_FALLBACK }"`);
    return DEFAULT_AGENT_FALLBACK;
  }

  // Last resort: pick the first agent directory that exists
  const agentsRoot = resolveSullaAgentsDir();
  console.log(`[GraphRegistry] getDefaultAgentId() — scanning agents root: "${ agentsRoot }"`);
  if (fs.existsSync(agentsRoot)) {
    const entries = fs.readdirSync(agentsRoot, { withFileTypes: true });
    const firstAgent = entries.find(e => e.isDirectory());
    if (firstAgent) {
      console.log(`[GraphRegistry] getDefaultAgentId() — picked first agent dir: "${ firstAgent.name }"`);
      return firstAgent.name;
    }
  }

  console.log(`[GraphRegistry] getDefaultAgentId() — no agents found, hard fallback: "${ DEFAULT_AGENT_FALLBACK }"`);
  return DEFAULT_AGENT_FALLBACK;
}

/**
 * Resolve the agent ID for a specific trigger type.
 * Checks triggerAgentMap first, then falls back to getDefaultAgentId().
 */
export async function getAgentIdForTrigger(triggerType: string): Promise<string> {
  console.log(`[GraphRegistry] getAgentIdForTrigger("${ triggerType }") — resolving...`);
  const triggerMap = await SullaSettingsModel.get('triggerAgentMap', {} as Record<string, string>);
  console.log(`[GraphRegistry] getAgentIdForTrigger() — triggerMap:`, JSON.stringify(triggerMap));
  const assigned = triggerMap[triggerType];
  if (assigned) {
    const agentDir = path.join(resolveSullaAgentsDir(), assigned);
    const exists = fs.existsSync(agentDir);
    console.log(`[GraphRegistry] getAgentIdForTrigger() — trigger "${ triggerType }" mapped to "${ assigned }", dir exists=${ exists }`);
    if (exists) return assigned;
    console.warn(`[GraphRegistry] getAgentIdForTrigger() — agent dir not found for "${ assigned }", falling back to default`);
  } else {
    console.log(`[GraphRegistry] getAgentIdForTrigger() — no mapping for "${ triggerType }", falling back to default`);
  }
  return getDefaultAgentId();
}

let threadCounter = 0;
let messageCounter = 0;

export function nextThreadId(): string {
  return `thread_${ Date.now() }_${ ++threadCounter }`;
}

export function nextMessageId(): string {
  return `msg_${ Date.now() }_${ ++messageCounter }`;
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
      role:     'user',
      content:  prompt,
      metadata: { source: 'heartbeat' },
    }],
    metadata: {
      action:               'use_tools',
      threadId,
      wsChannel,
      cycleComplete:        false,
      waitingForUser:       false,
      llmModel,
      llmLocal,
      options:              {},
      currentNodeId:        'input_handler',
      consecutiveSameNode:  0,
      iterations:           0,
      revisionCount:        0,
      maxIterationsReached: false,
      memory:               {
        knowledgeBaseContext: '',
        chatSummariesContext: '',
      },
      subGraph: {
        state:    'completed',
        name:     'hierarchical',
        prompt:   '',
        response: '',
      },
      finalSummary:         '',
      finalState:           'running',
      n8nLiveEventsEnabled: false,
      returnTo:             null,

      // Heartbeat-specific fields
      activeProjects:            '',
      availableSkills:           '',
      heartbeatCycleCount:       0,
      heartbeatMaxCycles:        10,
      heartbeatStatus:           'idle',
      heartbeatLastCycleSummary: '',
      currentFocus:              '',
      focusReason:               '',

      // Environmental context (loaded each cycle by HeartbeatNode)
      agentsContext: '',
      isSubAgent:    false,
    },
  };

  return state;
}

async function buildAgentState(wsChannel: string, threadId?: string, graphOpts?: { isTrustedUser?: 'trusted' | 'untrusted' | 'verify'; userVisibleBrowser?: boolean }): Promise<AgentGraphState> {
  const id = threadId ?? nextThreadId();

  console.log(`[GraphRegistry] buildAgentState() — wsChannel="${ wsChannel }", threadId="${ id }"`);

  const mode = await SullaSettingsModel.get('modelMode', 'local');
  const llmModel = mode === 'remote'
    ? await SullaSettingsModel.get('remoteModel', '')
    : await SullaSettingsModel.get('sullaModel', '');
  const llmLocal = mode === 'local';

  const agentConfig = await loadAgentConfig(wsChannel);
  console.log(`[GraphRegistry] buildAgentState() — agent config for "${ wsChannel }": name="${ agentConfig?.name || '(none)' }", hasPrompt=${ !!agentConfig?.prompt }, type="${ agentConfig?.type || '(none)' }"`);

  return {
    messages: [],
    metadata: {
      action:    'direct_answer',
      threadId:  id,
      wsChannel,

      cycleComplete:  false,
      waitingForUser: false,
      isSubAgent:     false,

      llmModel,
      llmLocal,
      options:              { abort: undefined },
      currentNodeId:        'input_handler',
      consecutiveSameNode:  0,
      iterations:           0,
      revisionCount:        0,
      maxIterationsReached: false,
      memory:               {
        knowledgeBaseContext: '',
        chatSummariesContext: '',
      },
      subGraph: {
        state:    'completed',
        name:     'hierarchical',
        prompt:   '',
        response: '',
      },
      finalSummary:         '',
      finalState:           'running',
      n8nLiveEventsEnabled: false,
      returnTo:             null,

      conversationId: id,

      isTrustedUser:      graphOpts?.isTrustedUser ?? 'trusted',
      userVisibleBrowser: graphOpts?.userVisibleBrowser ?? true,

      agent:          agentConfig,
      agentLoopCount: 0,
    },
  };
}

/**
 * Load agent configuration from ~/sulla/agents/{agentId}/
 * Reads agent.yaml for config and compiles all .md files into a single prompt.
 * Returns undefined if agent directory doesn't exist.
 */
async function loadAgentConfig(agentId: string): Promise<AgentGraphState['metadata']['agent']> {
  console.log(`[GraphRegistry] loadAgentConfig() — agentId="${ agentId }"`);
  if (!agentId) {
    console.log(`[GraphRegistry] loadAgentConfig() — empty agentId, returning undefined`);
    return undefined;
  }

  const agentDir = path.join(resolveSullaAgentsDir(), agentId);
  if (!fs.existsSync(agentDir)) {
    console.log(`[GraphRegistry] loadAgentConfig() — agent dir not found: ${ agentDir }`);
    return undefined;
  }

  const yamlPath = path.join(agentDir, 'agent.yaml');
  if (!fs.existsSync(yamlPath)) {
    console.log(`[GraphRegistry] loadAgentConfig() — agent.yaml not found: ${ yamlPath }`);
    return undefined;
  }
  console.log(`[GraphRegistry] loadAgentConfig() — found agent at ${ agentDir }`);

  try {
    const yaml = await import('yaml');
    const parsed = yaml.parse(fs.readFileSync(yamlPath, 'utf-8'));

    // Compile all .md files into a single prompt (no variable substitution)
    const entries = fs.readdirSync(agentDir, { withFileTypes: true });
    const mdFiles = entries
      .filter(e => e.isFile() && e.name.endsWith('.md') && e.name !== 'environment.md')
      .sort((a, b) => {
        // soul.md first, then alphabetical
        const order = (name: string) => name === 'soul.md' ? 0 : 1;
        return order(a.name) - order(b.name) || a.name.localeCompare(b.name);
      });

    const sections: string[] = [];
    for (const file of mdFiles) {
      const content = fs.readFileSync(path.join(agentDir, file.name), 'utf-8').trim();
      if (content) {
        sections.push(content);
      }
    }

    return {
      name:         parsed.name || agentId,
      description:  parsed.description || '',
      type:         parsed.type || 'worker',
      skills:       parsed.skills || [],
      tools:        parsed.tools || [],
      integrations: parsed.integrations || [],
      prompt:       sections.length > 0 ? sections.join('\n\n') : undefined,
    };
  } catch (err) {
    console.error(`[GraphRegistry] Failed to load agent config for ${ agentId }:`, err);
    return undefined;
  }
}

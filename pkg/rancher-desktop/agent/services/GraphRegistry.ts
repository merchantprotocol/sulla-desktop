import { Graph, createHeartbeatGraph, createAgentGraph, createSubconsciousGraph, BaseThreadState, AgentGraphState, GeneralGraphState } from '../nodes/Graph';
import { SullaSettingsModel } from '../database/models/SullaSettingsModel';
import { getCurrentModel, getCurrentMode } from '../languagemodels';
import { resolveSullaAgentsDir, resolveAllAgentsDirs, findAgentDir } from '../utils/sullaPaths';
import { toolRegistry } from '../tools/registry';
import { saveThreadState, loadThreadState } from '../nodes/ThreadStateStore';
import * as fs from 'fs';
import * as path from 'path';

// Side-effect: ensure tool manifests are registered before any graph runs
import '../tools/manifests';
// Back-compat re-export
export type { AgentGraphState as OverlordThreadState } from '../nodes/Graph';

const registry = new Map<string, {
  graph: Graph<any>;
  state: BaseThreadState;
}>();

// ============================================================================
// SUBCONSCIOUS MIDDLEWARE — TOOL ASSIGNMENTS
// ============================================================================

/** Summarizer: no tools — pure text analysis and XML output */
const SUMMARIZER_TOOLS: string[] = [];

/** Memory Recall: targeted searches for resources, tabs, credentials, environment, tools */
const MEMORY_RECALL_TOOLS: string[] = [
  'file_search',           // Search ~/sulla/resources/ for skills & workflows
  'read_file',             // Read SKILL.md, workflow YAML, environment docs
  'list_tabs',             // See what browser tabs are open
  'vault_list',            // List available integration service credentials
  'get_human_presence',    // Check if user is available
  'browse_tools',          // Search tool catalog by category or keyword
];

/** Observation Agent: manage observational memory and update identity files */
const OBSERVATION_AGENT_TOOLS: string[] = [
  'add_observational_memory',     // Store new observations
  'remove_observational_memory',  // Clean up stale observations
  'file_search',                  // Search identity/observation files
  'write_file',                   // Write updates to identity/observation files
];

// ============================================================================
// SUBCONSCIOUS MIDDLEWARE PROMPTS
// ============================================================================

const MEMORY_RECALL_PROMPT = `You are a READ-ONLY recall process. You gather context for a primary agent.

## Your job

Read the latest user message in the conversation. Based on what the human is
asking about, decide which (if any) of the resource categories below are
relevant. Only search categories that could plausibly contain useful context
for the request.

If the message is casual (a greeting, small talk, a simple question that
doesn't reference any project, tool, workflow, or task), return nothing.
Do not call any tools. Finish immediately.

If the message references a specific topic, project, tool, or task — search
only the categories that relate to it. For example:
- Mentions a project name or task → search Active Projects
- Asks to use a tool or integration → search Tools & Credentials
- Asks about a workflow or process → search Workflows & Skills
- Asks about the environment or infra → search Environment

Never search all categories by default. Be selective.

## Resource categories

### 1. Active Projects
Search \`~/sulla/projects/\` for project directories matching the topic.
Read the relevant PROJECT.md and \`~/sulla/projects/ACTIVE_PROJECTS.md\`.
Include project names, statuses, blockers, and next actions.

### 2. Skills
Search \`~/sulla/resources/skills/\` for skills relevant to the request.
For each match, read the SKILL.md and include the key instructions.

**Trigger matching** — When the user's message expresses intent to *do*
something, *create* something, *manage* something, or asks Sulla to perform
a task, scan the **Triggers** line in each SKILL.md to find skills whose
trigger phrases match or overlap with the user's intent. A skill is relevant
if:
- The user's words closely match one of the skill's trigger phrases, OR
- The user describes an activity that falls within the skill's category/tags,
  OR
- Completing the user's request would require the tools or procedures the
  skill defines.

When a matching skill is found, include its full trigger list, the file path
to the SKILL.md (e.g. \`~/sulla/resources/skills/<slug>/SKILL.md\`), and the
key instructions so the primary agent knows the skill is available, where to
find it, and how to invoke it.

### 3. Workflows
Search \`~/sulla/resources/workflows/\` for workflows relevant to the request.
For each match, read the YAML and include the workflow definition.

### 4. Open Tabs
Call \`list_tabs\` to see what the human currently has open in the browser.
Only do this when the conversation references browser activity or current work.

### 5. Credentials
Call \`vault_list\` to check for credentials related to a specific service
the human is asking about. Never list all credentials unprompted.

### 6. Environment
Search \`~/sulla/integrations/environment/\` for environment docs relevant
to the conversation. Read and include key details from matching files.

### 7. Tools & Connected Accounts
Use \`browse_tools\` to search for tools relevant to this conversation.
Only search when the human is asking about an integration or tool by name.
For relevant tools, call \`vault_list\` to check for connected accounts.

## Output format

Return your findings organized by section. Paste the actual content — skill
instructions, workflow YAML, project statuses, tab URLs, credential names,
environment details, tool entries. Cite file paths for everything you include.

Skip any section you did not search or that had no relevant results.
When done, finish immediately.`;

// ── Heartbeat-specific memory recall ──────────────────────────────────────

const HEARTBEAT_RECALL_TOOLS: string[] = [
  'file_search',           // Search ~/sulla/projects/ for active PRDs
  'read_file',             // Read PROJECT.md files and identity docs
  'get_human_presence',    // Check if user is available
];

const HEARTBEAT_RECALL_PROMPT = `You are a READ-ONLY recall process for the heartbeat agent. You gather active project context so the heartbeat knows what to work on.

## Your checklist

Complete these steps in order, then finish:

### 1. Active Projects
Search \`~/sulla/projects/\` for all project directories.
For each project found, read its PROJECT.md (the PRD).
Include the full PRD content for every active (non-archived) project.

### 2. Project Briefing
Read \`~/sulla/agents/sulla-desktop/projects.md\` — this is the daily planning briefing
with the current mode (PROPOSE/FOCUS/UNBLOCK) and ranked project proposals.
Include the full content.

### 3. Identity & Goals
Read \`~/sulla/identity/agent/goals.md\` and \`~/sulla/identity/human/goals.md\`.
Include any active goals or priorities.

### 4. Human Presence
Call \`get_human_presence\` to check if the human is available.
Include their status.

## Output format

Return your findings organized by section. Paste the actual PRD content — the
heartbeat agent needs the full details to decide what to work on.
Cite file paths for everything you include.

If a section has no relevant results, skip it entirely.
When all steps are done, finish immediately.`;

// ── Unstuck: Research Agent ───────────────────────────────────────────────

const UNSTUCK_RESEARCH_TOOLS: string[] = [
  'file_search',
  'read_file',
  'browse_tools',
  'browse_page',
  'vault_list',
  'integration_is_enabled',
];

const UNSTUCK_RESEARCH_PROMPT = `You are a research agent analyzing why a primary agent got stuck. Your job is to find concrete resources, approaches, and solutions that the agent can execute autonomously.

## Critical Rule — No Deferring to the Human

The primary agent got stuck because it thinks it needs human intervention. Your job is to prove it wrong. Every approach you return MUST be something the agent can do on its own with its available tools. Do not suggest "ask the human," "wait for credentials," or "get approval." Instead:
- If it needs credentials → check vault_list for existing ones, or find an alternative that doesn't need them
- If it thinks only a human can do something → find a tool, API, automation, or workaround the agent can use
- If it needs a decision → make a reasonable default and note it can be revised later
- If it needs access → find another path that uses what's already available

The agent has: exec, file system, browser automation, docker, integrations, calendar, memory, skills, workflows. That's a lot. Use it.

## Your checklist

1. **Skills & Workflows**: Search ~/sulla/resources/skills/ and ~/sulla/resources/workflows/ for anything relevant to the blocker.
2. **Integrations**: Check what integrations and credentials are available (vault_list, integration_is_enabled) that could help.
3. **Documentation**: Search ~/sulla/integrations/ and ~/sulla/docs/ for relevant docs.
4. **Code**: If the blocker is code-related, use file_search and read_file to find relevant source files.
5. **External**: If internal resources are insufficient, use browse_page to search for external solutions.

## Output format

Return exactly 3 approaches, ranked by likelihood of success. Every approach must be fully executable by the agent without human involvement:

### Approach 1: [Title]
**Evidence:** [what you found that supports this]
**Resources:** [file paths, URLs, tool names]
**Steps:**
1. [concrete step the agent can execute]
2. [concrete step the agent can execute]
3. [concrete step the agent can execute]

### Approach 2: [Title]
...

### Approach 3: [Title]
...

Be concrete. Cite file paths and URLs. The primary agent will use these directly.`;

// ── Unstuck: Constraint Relaxation Agent ──────────────────────────────────

const UNSTUCK_RELAXATION_TOOLS: string[] = [
  'read_file',
  'file_search',
];

const UNSTUCK_RELAXATION_PROMPT = `You are a creative problem-solving consultant. An AI agent tried to accomplish a task and got stuck. Your job is to think laterally about alternative approaches that the agent can execute on its own.

You intentionally have minimal tools. This forces creative thinking rather than falling back on more research.

## Critical Rule — The Agent Must Own This

The agent got stuck and wants to hand it off to the human. That's not an option. Every approach you suggest must be something the agent can do autonomously right now. Common traps to avoid:
- "Send a message asking the human to..." → No. The agent does this itself.
- "Wait for the human to provide..." → No. Find an alternative or make a reasonable assumption.
- "This requires human judgment..." → No. The agent makes the call and notes it for review later.

The agent has shell access, browser automation, docker, file system, integrations, calendar, memory, and a full tool suite. If it thinks it can't do something, it's probably wrong.

## Reframing questions to consider
- What is the simplest possible way to make progress, even if imperfect?
- What if you only had 5 minutes — what would you do?
- What if you ignored the current approach entirely and started fresh?
- Is there a manual/brute-force approach that bypasses the blocker?
- Can the goal be decomposed into a smaller first step?
- Is the agent overcomplicating this? What would a junior developer try?
- Is there a tool or integration already available that solves this differently?
- What would you do if you just made a reasonable default choice and moved on?

## Output format

Return exactly 3 alternative approaches, ordered from simplest to most ambitious. Every approach must be fully executable by the agent without human involvement:

### Simple: [Title]
**Why it might work:** [reasoning]
**Trade-offs:** [what you give up]
**Steps:**
1. [concrete step the agent can execute]
2. [concrete step the agent can execute]

### Moderate: [Title]
**Why it might work:** [reasoning]
**Trade-offs:** [what you give up]
**Steps:**
1. [concrete step the agent can execute]
2. [concrete step the agent can execute]
3. [concrete step the agent can execute]

### Ambitious: [Title]
**Why it might work:** [reasoning]
**Trade-offs:** [what you give up]
**Steps:**
1. [concrete step the agent can execute]
2. [concrete step the agent can execute]
3. [concrete step the agent can execute]

Be direct and actionable. No hedging. The agent needs concrete next steps, not analysis.`;


const OBSERVATION_AGENT_PROMPT = `You are the observation process for an AI agent.

CRITICAL: You are NOT the primary agent. You do NOT execute tasks, answer
questions, browse websites, call APIs, create files, or do anything the user
asked for. Another agent handles that. You ONLY manage observational memory.

Your ONLY jobs:
1. Review the conversation for important facts, decisions, preferences, or
   commitments that should be remembered long-term for all conversations. Save them with
   add_observational_memory.
2. Review current observations for anything stale or old that no longer needs remembering for all conversations. 
   Remove them with remove_observational_memory.
3. If something important should update an identity file at ~/sulla/identity/,
   read and update that specific file with exec. Nothing else.

when saving new observations, include why certain decisions were made (not just what). Like:

"Google Maps loaded with roofers — scrolled 3x, collected 5 results"
"Twenty account ID: local_merchant_protocol — verified working 2m ago"

If nothing needs to change, finish immediately.

Do NOT:
- Try to complete the user's task
- Search for tools, APIs, or integrations
- Run curl commands or interact with services
- Do anything beyond managing observations and identity files

Priority levels:
- 🔴 Critical: identity, strong preferences/goals, promises, deal-breakers
- 🟡 Valuable: decisions, patterns, progress markers
- ⚪ Low: minor/transient items (use sparingly)

Current observational memories:
{observations}`;

const SUMMARIZER_PROMPT = `You are the memory compression process for an AI agent. Talk through
what you're doing — which messages look irrelevant, which have useful facts
worth keeping, and what you're compressing. Then provide your decisions as XML.

Each message below has a unique message_id in its metadata. Your job is to
remove information that is completely irrelevant to accomplishing the current
goal. Either remove irrelevant messages or summarize them down to the
important contextual facts.

For each message, decide:
- DELETE: if the message is completely irrelevant to the current goal
- SUMMARIZE: if the message has some relevant facts but is too verbose — compress it
- KEEP: if the message is important as-is (do nothing, don't list it)

Return your decisions as XML. Reference messages by their unique message_id (NOT by index
position — positions change between loops).

<DELETE>
  <MESSAGE id="msg_1743500000000_1" />
  <MESSAGE id="msg_1743500000000_4" />
</DELETE>
<SUMMARIZE>
  <MESSAGE id="msg_1743500000000_2">The compressed essential facts from this message.</MESSAGE>
  <MESSAGE id="msg_1743500000000_5">Key decision: user chose option B for the auth flow.</MESSAGE>
</SUMMARIZE>

Rules:
- Only delete or summarize — never add new messages.
- Preserve the most recent messages (last 5-10) as they contain active context.
- Focus compression on older messages in the conversation.
- If nothing needs to change, return empty tags: <DELETE></DELETE><SUMMARIZE></SUMMARIZE>
- System messages should never be deleted or summarized.
- Always use the message_id attribute, never reference messages by position.`;

// XML parsing for summarizer response handler — uses message IDs (strings)
const DELETE_BLOCK_REGEX = /<DELETE>([\s\S]*?)<\/DELETE>/i;
const SUMMARIZE_BLOCK_REGEX = /<SUMMARIZE>([\s\S]*?)<\/SUMMARIZE>/i;
const DELETE_MESSAGE_REGEX = /<MESSAGE\s+id="([^"]+)"\s*\/>/gi;
const SUMMARIZE_MESSAGE_REGEX = /<MESSAGE\s+id="([^"]+)">([\s\S]*?)<\/MESSAGE>/gi;

function parseSummarizerXML(text: string): { deletions: Set<string>; summaries: Map<string, string> } {
  const deletions = new Set<string>();
  const summaries = new Map<string, string>();

  const deleteBlock = DELETE_BLOCK_REGEX.exec(text);
  if (deleteBlock) {
    let match;
    DELETE_MESSAGE_REGEX.lastIndex = 0;
    while ((match = DELETE_MESSAGE_REGEX.exec(deleteBlock[1])) !== null) {
      deletions.add(match[1]);
    }
  }

  const summarizeBlock = SUMMARIZE_BLOCK_REGEX.exec(text);
  if (summarizeBlock) {
    let match;
    SUMMARIZE_MESSAGE_REGEX.lastIndex = 0;
    while ((match = SUMMARIZE_MESSAGE_REGEX.exec(summarizeBlock[1])) !== null) {
      summaries.set(match[1], match[2].trim());
    }
  }

  return { deletions, summaries };
}

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
    graph: Graph<AgentGraphState>;
    state: AgentGraphState;
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

    // Try to restore from ThreadStateStore (Redis / in-memory fallback)
    const saved = await loadThreadState(threadId);
    if (saved) {
      console.log(`[GraphRegistry] getOrCreate() — restored from ThreadStateStore for threadId="${ threadId }", messages=${ saved.messages.length }`);
      const graph = createAgentGraph();
      // Ensure wsChannel is current (may have changed)
      saved.metadata.wsChannel = wsChannel;
      registry.set(threadId, { graph, state: saved });
      return { graph, state: saved as AgentGraphState };
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

  /**
   * Create a Subconscious graph — minimal multi-turn tool-calling loop.
   * Does not cache in registry (each invocation is ephemeral).
   */
  createSubconscious: async function(opts: {
    systemPrompt: string;
    tools: string[];
    userMessage: string;
    messages?: any[];
    maxIterations?: number;
    temperature?: number;
    format?: 'json';
    maxTokens?: number;
    responseHandler?: (response: string, state: BaseThreadState) => void;
    parentAbortSignal?: any;
    agentLabel?: string;
    parentConversationId?: string;
    parentWsChannel?: string;
  }): Promise<{
    graph:    Graph<BaseThreadState>;
    state:    BaseThreadState;
    threadId: string;
  }> {
    const graph = createSubconsciousGraph();
    const state = await buildSubconsciousState(opts);
    return { graph, state, threadId: state.metadata.threadId };
  },

  /**
   * Create a Summarizer graph — single-pass conversation compression.
   * Uses a responseHandler to parse XML delete/summarize instructions
   * and apply them to the original messages stored on metadata.
   */
  createSummarizer: async function(parentState: BaseThreadState): Promise<{
    graph:    Graph<BaseThreadState>;
    state:    BaseThreadState;
    threadId: string;
  }> {
    // Ensure every message has a unique ID for stable referencing across loops.
    // Store the ID on the ChatMessage.id field AND inject it visibly into the
    // content so the LLM can see and reference it in its XML response.
    const originalMessages = parentState.messages.map((msg: any) => {
      const id = msg.id || nextMessageId();
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      return {
        ...msg,
        id,
        content:  `[message_id: ${ id }]\n${ content }`,
        metadata: { ...(msg.metadata || {}), message_id: id },
      };
    });

    return this.createSubconscious({
      systemPrompt:           SUMMARIZER_PROMPT,
      tools:                  SUMMARIZER_TOOLS,
      userMessage:            'Review the conversation above and determine which messages to delete or summarize.',
      messages:               originalMessages,
      agentLabel:             'summarizer',
      parentWsChannel:        String(parentState.metadata.wsChannel || ''),
      parentConversationId:   (parentState.metadata as any).conversationId || (parentState.metadata as any).threadId,
      parentAbortSignal: (parentState.metadata as any).options?.abort,
      responseHandler(response: string, state: BaseThreadState) {
        let actions: { deletions: Set<string>; summaries: Map<string, string> };
        try {
          actions = parseSummarizerXML(response);
        } catch (err) {
          console.warn('[Summarizer] Failed to parse XML response:', err instanceof Error ? err.message : err);
          return;
        }
        if (actions.deletions.size === 0 && actions.summaries.size === 0) return;

        // Rebuild from the original parent messages (clean content, no
        // injected [message_id:] prefixes). originalMessages and
        // parentState.messages are 1:1 — use the tagged ID with the
        // clean parent message.
        const parentMessages = parentState.messages;
        const result: any[] = [];
        for (let i = 0; i < originalMessages.length; i++) {
          const msgId = originalMessages[i].id;
          const cleanMsg = parentMessages[i] || originalMessages[i];
          if (cleanMsg.role === 'system') { result.push({ ...cleanMsg, id: msgId }); continue; }
          if (actions.deletions.has(msgId)) continue;
          if (actions.summaries.has(msgId)) {
            result.push({
              ...cleanMsg,
              id:       msgId,
              content:  actions.summaries.get(msgId),
              metadata: { ...(cleanMsg.metadata || {}), message_id: msgId, _summarized: true, timestamp: Date.now() },
            });
            continue;
          }
          result.push({ ...cleanMsg, id: msgId });
        }

        (state.metadata as any).compressedMessages = result;
        (state.metadata as any).deletedCount = actions.deletions.size;
        (state.metadata as any).summarizedCount = actions.summaries.size;
        console.log(`[Summarizer] Compressed: deleted ${ actions.deletions.size }, summarized ${ actions.summaries.size }, kept ${ result.length } of ${ originalMessages.length }`);
      },
    });
  },

  /**
   * Create a Memory Recall graph — searches internal systems for relevant
   * skills, tools, resources, projects, and context.
   */
  createMemoryRecall: async function(parentState: BaseThreadState, variant?: 'default' | 'heartbeat'): Promise<{
    graph:    Graph<BaseThreadState>;
    state:    BaseThreadState;
    threadId: string;
  }> {
    const isHeartbeat = variant === 'heartbeat';
    const graph = createSubconsciousGraph();
    const state = await buildSubconsciousState({
      systemPrompt:           isHeartbeat ? HEARTBEAT_RECALL_PROMPT : MEMORY_RECALL_PROMPT,
      tools:                  isHeartbeat ? HEARTBEAT_RECALL_TOOLS : MEMORY_RECALL_TOOLS,
      userMessage:            isHeartbeat
        ? 'Load all active projects from ~/sulla/projects/, agent and human goals, and human presence. Return the full PRD content for each project.'
        : 'Read the latest user message in the conversation and decide what context is needed. Only search relevant categories — or return nothing if the message is casual.',
      messages:               [...parentState.messages],
      parentAbortSignal:      (parentState.metadata as any).options?.abort,
      agentLabel:             'memory-recall',
      parentWsChannel:        String(parentState.metadata.wsChannel || ''),
      parentConversationId:   (parentState.metadata as any).conversationId || (parentState.metadata as any).threadId,
    });
    return { graph, state, threadId: state.metadata.threadId };
  },

  /**
   * Create an Observation Agent graph — reviews conversation for important
   * facts to save to observational memory and cleans up stale observations.
   */
  createObservationAgent: async function(parentState: BaseThreadState, currentObservations: string): Promise<{
    graph:    Graph<BaseThreadState>;
    state:    BaseThreadState;
    threadId: string;
  }> {
    const graph = createSubconsciousGraph();
    const state = await buildSubconsciousState({
      systemPrompt:           OBSERVATION_AGENT_PROMPT.replace('{observations}', currentObservations),
      tools:                  OBSERVATION_AGENT_TOOLS,
      userMessage:            'Review this conversation. Save any important facts, decisions, or preferences to observational memory. Remove any stale or irrelevant observations. Update identity files if warranted.',
      messages:               [...parentState.messages],
      parentAbortSignal:      (parentState.metadata as any).options?.abort,
      agentLabel:             'observation',
      parentWsChannel:        String(parentState.metadata.wsChannel || ''),
      parentConversationId:   (parentState.metadata as any).conversationId || (parentState.metadata as any).threadId,
    });
    return { graph, state, threadId: state.metadata.threadId };
  },

  /**
   * Create an Unstuck Research agent — searches skills, workflows, integrations,
   * docs, and external resources to find concrete solutions for a blocked agent.
   */
  createUnstuckResearch: async function(parentState: BaseThreadState): Promise<{
    graph:    Graph<BaseThreadState>;
    state:    BaseThreadState;
    threadId: string;
  }> {
    const agentMeta = (parentState.metadata as any).agent || {};
    const blockerContext = [
      agentMeta.blocker_reason ? `Blocker: ${ agentMeta.blocker_reason }` : '',
      agentMeta.unblock_requirements ? `Requirements: ${ agentMeta.unblock_requirements }` : '',
      agentMeta.status_note ? `Status: ${ agentMeta.status_note }` : '',
      `Agent status: ${ agentMeta.status || 'unknown' }`,
      `Loop count: ${ (parentState.metadata as any).agentLoopCount || 0 }`,
    ].filter(Boolean).join('\n');

    return this.createSubconscious({
      systemPrompt:         UNSTUCK_RESEARCH_PROMPT,
      tools:                UNSTUCK_RESEARCH_TOOLS,
      userMessage:          `The primary agent is stuck. Here is the context:\n\n${ blockerContext }\n\nResearch solutions using your available tools.`,
      messages:             [...parentState.messages],
      parentAbortSignal:    (parentState.metadata as any).abortSignal || (parentState.metadata as any).options?.abort,
      agentLabel:           'unstuck-research',
      parentWsChannel:      String(parentState.metadata.wsChannel || ''),
      parentConversationId: (parentState.metadata as any).conversationId || (parentState.metadata as any).threadId,
    });
  },

  /**
   * Create an Unstuck Constraint Relaxation agent — thinks creatively about
   * simpler and alternative approaches when the primary agent is stuck.
   */
  createUnstuckRelaxation: async function(parentState: BaseThreadState): Promise<{
    graph:    Graph<BaseThreadState>;
    state:    BaseThreadState;
    threadId: string;
  }> {
    const agentMeta = (parentState.metadata as any).agent || {};
    const blockerContext = [
      agentMeta.blocker_reason ? `Blocker: ${ agentMeta.blocker_reason }` : '',
      agentMeta.unblock_requirements ? `Requirements: ${ agentMeta.unblock_requirements }` : '',
      agentMeta.status_note ? `Status: ${ agentMeta.status_note }` : '',
      `Agent status: ${ agentMeta.status || 'unknown' }`,
      `Loop count: ${ (parentState.metadata as any).agentLoopCount || 0 }`,
    ].filter(Boolean).join('\n');

    return this.createSubconscious({
      systemPrompt:         UNSTUCK_RELAXATION_PROMPT,
      tools:                UNSTUCK_RELAXATION_TOOLS,
      userMessage:          `The primary agent is stuck. Here is the context:\n\n${ blockerContext }\n\nPropose creative alternative approaches.`,
      messages:             [...parentState.messages],
      parentAbortSignal:    (parentState.metadata as any).abortSignal || (parentState.metadata as any).options?.abort,
      agentLabel:           'unstuck-relaxation',
      parentWsChannel:      String(parentState.metadata.wsChannel || ''),
      parentConversationId: (parentState.metadata as any).conversationId || (parentState.metadata as any).threadId,
    });
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
  const id = await SullaSettingsModel.get('defaultAgentId', 'sulla-desktop');
  if (id) {
    console.log(`[GraphRegistry] getDefaultAgentId() — found setting: "${ id }"`);
    return id;
  }

  // If no setting yet, check if chat-controller exists
  if (findAgentDir(DEFAULT_AGENT_FALLBACK)) {
    console.log(`[GraphRegistry] getDefaultAgentId() — no setting, using fallback dir: "${ DEFAULT_AGENT_FALLBACK }"`);
    return DEFAULT_AGENT_FALLBACK;
  }

  // Last resort: pick the first agent directory that exists
  for (const agentsRoot of resolveAllAgentsDirs()) {
    console.log(`[GraphRegistry] getDefaultAgentId() — scanning agents root: "${ agentsRoot }"`);
    if (fs.existsSync(agentsRoot)) {
      const entries = fs.readdirSync(agentsRoot, { withFileTypes: true });
      const firstAgent = entries.find(e => e.isDirectory());
      if (firstAgent) {
        console.log(`[GraphRegistry] getDefaultAgentId() — picked first agent dir: "${ firstAgent.name }"`);
        return firstAgent.name;
      }
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
  const triggerMap: Record<string, string> = {
    'sulla-desktop': 'sulla-desktop',
    'workbench': 'sulla-desktop',
    'heartbeat': 'dreaming-protocol',
  };

  const assigned = triggerMap[triggerType];
  if (assigned) {
    const agentDir = findAgentDir(assigned);
    const exists = !!agentDir;
    console.log(`[GraphRegistry] getAgentIdForTrigger() — trigger "${ triggerType }" mapped to "${ assigned }", dir exists=${ exists }`);
    // Return the mapped ID whether or not the dir exists — buildAgentState
    // gracefully handles missing agent dirs (runs with default prompts/tools).
    return assigned;
  }

  console.log(`[GraphRegistry] getAgentIdForTrigger() — no mapping for "${ triggerType }", using triggerType as agentId`);
  return triggerType || 'sulla-desktop';
}

let threadCounter = 0;
let messageCounter = 0;

export function nextThreadId(): string {
  return `thread_${ Date.now() }_${ ++threadCounter }`;
}

export function nextMessageId(): string {
  return `msg_${ Date.now() }_${ ++messageCounter }`;
}

async function buildHeartbeatState(wsChannel: string, prompt: string): Promise<AgentGraphState> {
  const heartbeatProvider = await SullaSettingsModel.get('heartbeatProvider', 'default');

  // Resolve provider to model/local flags
  let llmModel: string;
  let llmLocal: boolean;

  if (heartbeatProvider === 'default' || heartbeatProvider === 'ollama') {
    if (heartbeatProvider === 'default') {
      llmModel = await getCurrentModel();
      llmLocal = (await getCurrentMode()) === 'local';
    } else {
      llmModel = await SullaSettingsModel.get('sullaModel', '');
      llmLocal = true;
    }
  } else {
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

  // Load agent config for the heartbeat channel (dreaming-protocol)
  const agentConfig = await loadAgentConfig(wsChannel);

  const state: AgentGraphState = {
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
      isSubAgent:           false,
      subAgentDepth:        0,
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

      agent:          agentConfig,
      agentLoopCount: 0,
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
      subAgentDepth:  0,

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
 * Reads config.yaml for config and compiles all .md files into a single prompt.
 * Returns undefined if agent directory doesn't exist.
 */
async function loadAgentConfig(agentId: string): Promise<AgentGraphState['metadata']['agent']> {
  console.log(`[GraphRegistry] loadAgentConfig() — agentId="${ agentId }"`);
  if (!agentId) {
    console.log(`[GraphRegistry] loadAgentConfig() — empty agentId, returning undefined`);
    return undefined;
  }

  const agentDir = findAgentDir(agentId);
  if (!agentDir) {
    console.log(`[GraphRegistry] loadAgentConfig() — agent dir not found for: ${ agentId }`);
    return undefined;
  }

  const yamlPath = path.join(agentDir, 'config.yaml');
  if (!fs.existsSync(yamlPath)) {
    console.log(`[GraphRegistry] loadAgentConfig() — config.yaml not found: ${ yamlPath }`);
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
      excludeSoul:  parsed.excludeSoul === true,
    };
  } catch (err) {
    console.error(`[GraphRegistry] Failed to load agent config for ${ agentId }:`, err);
    return undefined;
  }
}

async function buildSubconsciousState(opts: {
  systemPrompt: string;
  tools: string[];
  userMessage: string;
  messages?: any[];
  maxIterations?: number;
  temperature?: number;
  format?: 'json';
  maxTokens?: number;
  responseHandler?: (response: string, state: BaseThreadState) => void;
  parentAbortSignal?: any;
  /** Label for logging — identifies which subconscious agent this is */
  agentLabel?: string;
  /** Parent conversation ID for log tracing */
  parentConversationId?: string;
  /** Parent's WebSocket channel — subconscious agents push thinking messages here */
  parentWsChannel?: string;
}): Promise<BaseThreadState> {
  const threadId = `subconscious_${ Date.now() }_${ ++threadCounter }`;

  const mode = await SullaSettingsModel.get('modelMode', 'local');
  const llmModel = mode === 'remote'
    ? await SullaSettingsModel.get('remoteModel', '')
    : await SullaSettingsModel.get('sullaModel', '');
  const llmLocal = mode === 'local';

  // Pre-resolve tool schemas for the LLM
  const llmTools = await Promise.all(
    opts.tools.map(name => toolRegistry.convertToolToLLM(name)),
  );

  // Build messages: use provided messages array + append user message, or just user message
  const messages: any[] = opts.messages
    ? [...opts.messages, { role: 'user', content: opts.userMessage, metadata: { source: 'subconscious' } }]
    : [{ role: 'user', content: opts.userMessage, metadata: { source: 'subconscious' } }];

  return {
    messages,
    // llmTools must be on the top-level state object — normalizedChat()
    // reads (state as any).llmTools, NOT state.metadata.llmTools
    llmTools,
    metadata: {
      action:               'use_tools',
      threadId,
      conversationId:       threadId,
      parentConversationId: opts.parentConversationId,
      parentWsChannel:      opts.parentWsChannel,
      agentLabel:           opts.agentLabel,
      wsChannel:            opts.agentLabel ? `subconscious:${ opts.agentLabel }` : 'subconscious',
      cycleComplete:        false,
      waitingForUser:       false,
      isSubAgent:           true,
      subAgentDepth:        0,
      llmModel,
      llmLocal,
      options:              { abort: opts.parentAbortSignal },
      currentNodeId:        'subconscious',
      consecutiveSameNode:  0,
      iterations:           0,
      revisionCount:        0,
      maxIterationsReached: false,
      memory:               { knowledgeBaseContext: '', chatSummariesContext: '' },
      subGraph:             { state: 'completed', name: '', prompt: '', response: '' },
      finalSummary:         '',
      finalState:           'running',
      n8nLiveEventsEnabled: false,
      returnTo:             null,

      // Subconscious-specific fields
      systemPrompt:     opts.systemPrompt,
      allowedToolNames: opts.tools,
      temperature:      opts.temperature,
      format:           opts.format,
      maxTokens:        opts.maxTokens,
      responseHandler:  opts.responseHandler,
    },
  } as any;
}

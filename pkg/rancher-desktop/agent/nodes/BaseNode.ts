import type { BaseThreadState, NodeResult } from './Graph';
import type { ToolResult, ThreadState } from '../types';
import path from 'node:path'; // used by enrichPrompt for active_projects_file
import type { WebSocketMessageHandler } from '../services/WebSocketClientService';
import { getCurrentMode, getLocalService, getService, getPrimaryService, getSecondaryService } from '../languagemodels';
import { parseJson } from '../services/JsonParseService';
import { getWebSocketClientService } from '../services/WebSocketClientService';
import { SullaSettingsModel } from '../database/models/SullaSettingsModel';
import { BaseLanguageModel, ChatMessage, NormalizedResponse } from '../languagemodels/BaseLanguageModel';
import { throwIfAborted } from '../services/AbortService';
import { toolRegistry } from '../tools/registry';
import { BaseTool } from '../tools/base';
import { ConversationSummaryService } from '../services/ConversationSummaryService';
import { ObservationalSummaryService } from '../services/ObservationalSummaryService';
import { resolveSullaProjectsDir, resolveSullaSkillsDir } from '../utils/sullaPaths';

// ============================================================================
// DEFAULT SETTINGS
// ============================================================================

const DEFAULT_WS_CHANNEL = 'dreaming-protocol';

export const JSON_ONLY_RESPONSE_INSTRUCTIONS = `When you respond it will be parsed as JSON and ONLY the following object will be read.
Any text outside this exact structure will break downstream parsing.\nRespond ONLY with this valid JSON — nothing before, nothing after, no fences, no commentary:`;

export const TOOLS_RESPONSE_JSON = `  "tools": [
    ["tool_name", "arg1", "arg2"] - run any tool with exec form
    ["emit_chat_message", "Respond to the users inquiry"]
  ],`;

export const OBSERVATIONAL_MEMORY_SOP = `### SOP: add_observational_memory

Call **immediately** when **any** of these triggers fire:

Must-call triggers:
1. User expresses/changes preference, goal, constraint, hard no, identity signal, desired name/nickname
2. User commits (deadline, budget, deliverable, strategy, “from now on”, “always/never again”)
3. Recurring pattern confirmed in user requests/behavior
4. Breakthrough, major insight, painful lesson (yours or user’s)
5. You create/edit/delete/rename/configure anything persistent (article, memory, event, setting, container, agent, workflow, prompt, tool, integration)
6. Important new/confirmed info about tools, environment, APIs, limits, capabilities
7. High-value tool result that will shape future reasoning

Priority (pick exactly one):
🔴 Critical   = identity, strong prefs/goals, promises, deal-breakers, core constraints
🟡 Valuable   = decisions, patterns, reusable tool outcomes, progress markers
⚪ Low        = transient/minor (almost never use)

Content rules – enforced:
- Exactly one concise sentence
- Third-person/neutral voice only (“Human prefers…”, “User committed to…”)
- No “I” or “you”
- Always include specifics when they exist: dates, numbers, names, versions, exact phrases, URLs
- Maximize signal per character – never vague`;

// ============================================================================
// INTERFACES AND TYPES
// ============================================================================

export interface LLMCallOptions {
    model?: string;
    maxTokens?: number;
    format?: 'json' | undefined;
    temperature?: number;
    signal?: AbortSignal;
    disableTools?: boolean;
    nodeRunPolicy?: NodeRunPolicy;
    allowedToolCategories?: string[];
    allowedToolNames?: string[];
}

export interface NodeRunPolicy {
    messageSource?: 'graph';
    persistAssistantToGraph?: boolean;
}

export interface NodeRunContext {
    runId: string;
    nodeId: string;
    nodeName: string;
    messages: ChatMessage[];
    toolTranscript: Array<{ toolName: string; success: boolean; result?: unknown; error?: string }>;
    hadToolCalls: boolean;
    hadUserMessages: boolean;
    policy: Required<NodeRunPolicy>;
}

export interface LLMResponse {
    content: string | Record<string, any>;
    model: string;
}

export interface PromptEnrichmentOptions {
  includeSoul?: boolean;
  includeAwareness?: boolean;
  includeEnvironment?: boolean;
  includeMemory?: boolean;
  includeTools?: boolean;
}



// ============================================================================
// Supporting functions
// ============================================================================

async function getSoulPrompt(): Promise<string> {
  const prompt = await SullaSettingsModel.get('soulPrompt', '');
  const botName = await SullaSettingsModel.get('botName', 'Sulla');
  const primaryUserName = await SullaSettingsModel.get('primaryUserName', '');

  // Build prefix with bot name and optional user name
  const prefix = primaryUserName.trim()
    ? `You are Sulla Desktop, and you like to be called ${botName}\nThe Human's name is: ${primaryUserName}\n\n`
    : `You are Sulla Desktop, and you like to be called ${botName}\n\n`;

  return prefix + prompt;
}


export const ENVIRONMENT_PROMPT = `---
# Core Identity & Principles

You are an expert autonomous agent (Sulla) operating inside a highly capable, purpose-built runtime environment.

You exist to complete every user request with maximum reliability, efficiency, and intelligence.

**You ALWAYS follow these principles (non-negotiable):**
- Prefer your built-in environment and tools before any alternative.
- Use the skill system when you know a relevant skill exists or are creating one.
- You think step-by-step in <thinking> tags.
- You perform macro reflection every 4 turns or when stuck (using your MACRO_REVIEW rule).
- You never get stuck optimizing something unnecessary — always prefer simpler/better overall solutions.
- When you finish a successful task, you automatically consider distilling it into a new skill.
- when you have nothing new to add to the conversation, end the turn.

# Environment & Persistent Systems

You operate inside a custom runtime that contains the following built-in persistent systems. All of them are immediately available to you via tools.

Current datetime: {{formattedTime}}
Computer time zone: {{timeZone}}

### Calendar System
The single source of truth for all time-based actions. Reminders, meetings, recurring reports, and scheduled tasks are stored as calendar events. Events automatically trigger at the scheduled time with full context. You use this to manage any time-sensitive work.

### Observational Memory (short-term context layer)
Timestamped snapshot entries delivered as assistant messages. Each entry contains:
- UTC timestamp (ISO)
- Status indicator (🔴 significant, 🟡 completed)
- Neutral factual sentences about user requests, confirmations, submissions, or state changes
- Optional reference slugs

The current snapshot includes repeated records of user confirmations and formal requests for the n8n workflow PRD titled “daily X/Twitter + RSS + GitHub AI intelligence monitor” (uses Sulla’s local AI endpoint at http://host.docker.internal:3000/v1/chat/completions, stores curated dated reports to long-term memory, delivers Slack digest for YouTube topic ideation). You use this layer for immediate continuity.

### Long-term Memory (vector database)
Your permanent knowledge base and identity store containing:
- SOPs and skills
- Project documentation (solutions-architect format: user stories, MoSCoW, architecture, acceptance criteria)
- Wikipedia-style reference pages
- Project resource documents (PRDs) — the source of truth for every active project

You query this whenever you need historical context or project details.

### Workspaces
Dedicated project folders in the user data directory. One workspace per project containing code, assets, and outputs. You access them via list/read tools using full absolute paths.

### Docker Environment
Full Docker runtime with host access. You can launch safe containers and images. Workspace directories are mounted via docker-compose for hot reloading. You have dedicated docker tools for full container management.

### Automation Workflows (n8n)
n8n is your automation engine with thousands of templates. You have full control via:
- WebSocket integration (live events, trigger socket updates)
- API bridge (read/update/run workflows, inspect state)
- Postgres integration (persist workflow state)
- Docker integration (same containerized environment)

When automation is active you run a monitor-and-act loop: getCurrentWorkflowState() → decide changes → updateNode()/runWorkflow() → waitForExecutionComplete() → analyze logs.

### Tools
You have rich built-in tools across multiple categories: {{tool_categories}}.  
You can use browse_tools to navigate a full catalog of tools
Never start by using exec when you have specific built tools.

### OpenAI Compatible API
Local OpenAI-compatible server:
- Parent machine: http://localhost:3000
- Inside Docker: http://host.docker.internal:3000
All endpoints prefixed with /v1/.

### Codebase
Your agent codebase is at https://github.com/sulla-ai/sulla-desktop.  
Architecture and system docs live in the /doc folder.

### Extensions — Software Marketplace (IMPORTANT)
You have access to a **rich marketplace of pre-built, pre-configured open-source software** that can be installed with a single tool call. The catalog includes production-grade applications across many categories — project management, CRM, ERP, notifications, social media, cloud storage, email servers, media servers, document tools, smart home, voice AI, and more. New extensions are added regularly.

**Before building something from scratch or suggesting the human install software manually**, call \`list_extension_catalog\` to check if a ready-made extension already exists. Prefer installing an extension over DIY — these are fully configured and launch automatically.

You can install extensions autonomously with \`install_extension\`. Once installed, you can interact with them via their web UIs (Playwright tools), APIs, and Docker tools. Each extension supports lifecycle commands: start, stop, restart, status, update, logs.

**Tools:** \`list_extension_catalog\`, \`list_installed_extensions\`, \`install_extension\`, \`uninstall_extension\`
{{installed_extensions}}

### Playwright & Web Interaction
Full Playwright tool suite for browsing and interacting with websites.  
You activate assets with manage_active_asset(action: 'upsert', assetType: 'iframe', url: '...', title: '...').  
Remove them when finished. highly prefer these tools for any web task.

# SKILL SYSTEM

You have a permanent, growing library of expert skills stored at {{skills_dir}}.

**When to use skills:**
- If the user explicitly asks you to follow a skill, or you know a skill exists for the task, call load_skill("exact-skill-name") and follow it.
- If you are about to create a new skill, call search_skills first to avoid duplicates.
- Native skills (marked as "native" in search results) are executable code — call them directly like any other tool.
- Do NOT call search_skills as a pre-check on every task. Only search when you specifically intend to load or create a skill.

**Creating skills:**
- If the user asks to create/build/make a skill:
    a. Output your <GAME_PLAN>.
    b. Wait for explicit user approval.
    c. Output the COMPLETE SKILL.md inside <NEW_SKILL> tags.
    d. Call create_skill("kebab-case-skill-name", "the entire markdown content string").
    e. Confirm to the user.

Current skills directory: {{skills_dir}}

# PROJECT SYSTEM

You have a project management system for tracking structured workspaces. Each project has a \`PROJECT.md\` (the PRD — full project resource document) and a \`README.md\`.

**Tools:**
- \`search_projects\` (always available in meta) — find existing projects by name/description/status/tags
- \`load_project\` — load the full PROJECT.md content
- \`create_project\` — create a new project folder with PROJECT.md + README.md scaffold
- \`update_project\` — overwrite the entire PROJECT.md
- \`patch_project\` — update a specific markdown section without rewriting the whole file
- \`delete_project\` — remove a project

**Rules:**
- Before creating a new project, call search_projects to check for duplicates.
- Use patch_project for incremental updates to specific sections.
- Projects live at {{projects_dir}} by default.
- Do NOT call search_projects as a pre-check on every task. Only search when you intend to create or load a project.
- The active projects file is {{active_projects_file}}. When you create or work on a project that is truly active (not archived or completed), ensure it is listed there. If a project is no longer active, remove it from this file by updating the project status to "completed" or "archived". The agent may directly edit this file to curate the active list.

Current projects directory: {{projects_dir}}
---
`;

// ============================================================================
// Primary Classes
// ============================================================================

/**
 * 
 */
export abstract class BaseNode<T extends BaseThreadState = BaseThreadState> {
    id: string;
    name: string;
    protected llm: BaseLanguageModel | null = null;
    private currentNodeRunContext: NodeRunContext | null = null;

    constructor(id: string, name: string) {
        this.id = id;
        this.name = name;
    }

    abstract execute(state: T): Promise<NodeResult<T>>;

    protected bumpStateVersion(_state: BaseThreadState): void {
        // Version tracking removed: state mutations are applied on live references.
    }

    protected insertAssistantContextBeforeLatestUser(state: BaseThreadState, message: ChatMessage): void {
        const target = Array.isArray(state.messages) ? state.messages : [];
        if (!Array.isArray(state.messages)) {
            state.messages = target;
        }

        let latestUserIndex = -1;
        for (let i = target.length - 1; i >= 0; i--) {
            if (target[i]?.role === 'user') {
                latestUserIndex = i;
                break;
            }
        }

        if (latestUserIndex >= 0) {
            target.splice(latestUserIndex, 0, message);
            return;
        }

        target.push(message);
    }

    /**
     * 
     * @param basePrompt 
     * @param state 
     * @param options 
     * @returns 
     */
    protected async enrichPrompt(
        basePrompt: string,
        state: ThreadState,
        options: PromptEnrichmentOptions,
    ): Promise<string> {

        const parts: string[] = [];

        if (options.includeSoul) {
            const soulPrompt = await getSoulPrompt();
            if (soulPrompt.trim()) {
                parts.push(soulPrompt);
            }
        }

        let AwarenessMessage = ENVIRONMENT_PROMPT;

            /////////////////////////////////////////////////////////////////
            // add the tool categories
            /////////////////////////////////////////////////////////////////
            const categoriesWithDesc = toolRegistry.getCategoriesWithDescriptions();
            const categoriesText = categoriesWithDesc.map(({category, description}) => `- ${category}: ${description}`).join('\n');
            AwarenessMessage = AwarenessMessage.replace('{{tool_categories}}', categoriesText);


            /////////////////////////////////////////////////////////////////
            // adds the users time
            /////////////////////////////////////////////////////////////////
            const now = new Date();
            const formattedTime = now.toLocaleString('en-US', {
                timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                weekday: 'long',
                year: 'numeric',
                month: 'long',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: true,
            });
            const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown';
            const projectsDir = resolveSullaProjectsDir();
            const skillsDir = resolveSullaSkillsDir();
            const activeProjectsFile = path.join(projectsDir, 'ACTIVE_PROJECTS.md');

            AwarenessMessage = AwarenessMessage.replaceAll('{{formattedTime}}', formattedTime);
            AwarenessMessage = AwarenessMessage.replaceAll('{{timeZone}}', timeZone);
            AwarenessMessage = AwarenessMessage.replaceAll('{{skills_dir}}', skillsDir);
            AwarenessMessage = AwarenessMessage.replaceAll('{{projects_dir}}', projectsDir);
            AwarenessMessage = AwarenessMessage.replaceAll('{{active_projects_file}}', activeProjectsFile);

            /////////////////////////////////////////////////////////////////
            // resolve installed extensions into environment awareness
            /////////////////////////////////////////////////////////////////
            let installedExtensionsBlock = '';
            try {
                const { getExtensionService } = await import('../services/ExtensionService');
                const svc = getExtensionService();
                await svc.initialize();
                const installed = await svc.fetchInstalledExtensions();

                if (installed.length > 0) {
                    const lines = installed.map(ext => {
                        const title = ext.labels?.['org.opencontainers.image.title'] ?? ext.id;
                        const desc = ext.labels?.['org.opencontainers.image.description'] ?? '';
                        const urls = ext.extraUrls.map((u: any) => `${u.label}: ${u.url}`).join(', ');
                        return `- **${title}** (${ext.id}) v${ext.version}${urls ? ` — ${urls}` : ''}${desc ? ` — ${desc}` : ''}`;
                    });
                    installedExtensionsBlock = `\n#### Currently Installed Extensions (active products you can use)\nThese are running locally and our preferred system for you to interact with via their web UIs, APIs, database, and Docker tools:\n${lines.join('\n')}`;
                }
            } catch { /* extension service not available */ }
            AwarenessMessage = AwarenessMessage.replaceAll('{{installed_extensions}}', installedExtensionsBlock);

        if (options.includeEnvironment !== false) {
            parts.push(AwarenessMessage);

            /////////////////////////////////////////////////////////////////
            // adds active website assets state to the environment context
            // Lazy import to avoid pulling injected scripts into the background build
            /////////////////////////////////////////////////////////////////
            try {
                const { hostBridgeRegistry } = await import('../scripts/injected/HostBridgeRegistry');
                const activePagesContext = await hostBridgeRegistry.getSystemPromptContext();
                if (activePagesContext) {
                    parts.push(activePagesContext);
                }
            } catch { /* registry not available in this context */ }
        }

        /////////////////////////////////////////////////////////////////
        // adds observational memories to the message thread
        /////////////////////////////////////////////////////////////////
        if (options.includeAwareness) {
            if (state.metadata.awarenessIncluded !== true) {

                const observationalMemory = await SullaSettingsModel.get('observationalMemory', {});
                let memoryObj: any;
                let memoryText: string = '';

                try {
                    memoryObj = parseJson(observationalMemory);
                } catch (e) {
                    console.error('Failed to parse observational memory:', e);
                    memoryObj = {};
                }

                // Format observational memory into readable text
                if (Array.isArray(memoryObj)) {
                    memoryText = memoryObj.map((entry: any) => 
                        `${entry.priority} ${entry.timestamp} ${entry.content}`
                    ).join('\n');
                }
                
                this.insertAssistantContextBeforeLatestUser(state, {
                    role: 'assistant',
                    content: `\nYour Observational Memory Storage:\n${memoryText}`,
                    metadata: {
                        nodeId: this.id,
                        timestamp: Date.now()
                    }
                });
                this.bumpStateVersion(state);
                state.metadata.awarenessIncluded = true;
            }

            parts.push(OBSERVATIONAL_MEMORY_SOP);
        }
        
        // Always preserve the caller's base prompt and enrich around it.
        // Keep this after soul + environment context so node-specific directives
        // are anchored by runtime constraints and active asset state.
        if (basePrompt?.trim()) {
            parts.push(basePrompt.trim());
        }

        return parts.join('\n\n');
    }

    /**
     * 
     * @param state 
     * @param systemPrompt 
     * @param options 
     * @returns 
     */
    protected async chat(
        state: BaseThreadState,
        systemPrompt: string,
        options: LLMCallOptions = {}
    ): Promise<any | null> {
        const reply = await this.normalizedChat(state, systemPrompt, options);
        if (!reply) return null;
        if (options.format === 'json') {
            const parsedReply = this.parseJson(reply.content);
            console.log(`[${this.name}] Parsed JSON in method:chat:`, parsedReply);
            return parsedReply;
        }
        return reply.content;
    }

    protected triggerBackgroundStateMaintenance(state: BaseThreadState): void {
        ConversationSummaryService.triggerBackgroundSummarization(state);
        ObservationalSummaryService.triggerBackgroundTrimming(state);
    }

    /**
     * Deterministic message maintenance: awaits chat summary condensation and
     * observational awareness trimming before continuing. Use this at the top
     * of any node's execute() that runs in a loop (AgentNode) to
     * prevent unbounded message growth between cycles.
     *
     * Fast-path: if messages are below the threshold, returns immediately.
     * Slow-path: calls ConversationSummaryService.summarizeNow() which batches
     * the oldest messages into observational memory, then trims observations.
     */
    protected async ensureMessageBudget(state: BaseThreadState): Promise<void> {
        const messageCount = state.messages.length;
        const charWeight = state.messages.reduce((sum, m) => {
            const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
            return sum + content.length;
        }, 0);

        // Hard character budget: ~384k chars ≈ 96k tokens at 4 chars/token
        const HARD_CHAR_BUDGET = 384_000;
        // Soft message count threshold — triggers LLM summarization
        const SOFT_MESSAGE_THRESHOLD = 20;

        if (messageCount <= SOFT_MESSAGE_THRESHOLD && charWeight <= HARD_CHAR_BUDGET) {
            return;
        }

        // If over hard char budget, do a fast synchronous trim first (no LLM)
        if (charWeight > HARD_CHAR_BUDGET) {
            this.fastTrimByWeight(state, HARD_CHAR_BUDGET);
        }

        // Then run the LLM-backed summarization to compress further
        if (state.messages.length > SOFT_MESSAGE_THRESHOLD) {
            console.log(`[${this.name}] ensureMessageBudget: ${messageCount} messages, ${Math.round(charWeight / 1000)}k chars — running summarization`);
            await ConversationSummaryService.summarizeNow(state);
            ObservationalSummaryService.triggerBackgroundTrimming(state);
        }
    }

    /**
     * Build a map of paired tool_use/tool_result message indices.
     * Returns a Map where each index in a pair maps to the other index.
     * This ensures both halves are always kept or dropped together.
     */
    private static buildToolPairMap(messages: ChatMessage[]): Map<number, number> {
        const pairs = new Map<number, number>();
        for (let i = 0; i < messages.length - 1; i++) {
            const msg = messages[i];
            const next = messages[i + 1];

            // assistant with native tool_use content array
            if (msg.role === 'assistant' && Array.isArray(msg.content)
                && msg.content.some((b: any) => b?.type === 'tool_use')) {
                // next must be user with tool_result content array
                if (next.role === 'user' && Array.isArray(next.content)
                    && next.content.some((b: any) => b?.type === 'tool_result')) {
                    pairs.set(i, i + 1);
                    pairs.set(i + 1, i);
                }
            }
        }
        return pairs;
    }

    /**
     * Fast synchronous trim: evicts oldest non-protected messages by character
     * weight until under budget. No LLM call. Protects system messages, the
     * latest user message, and tool_use/tool_result pairs (always kept or
     * dropped together).
     */
    private fastTrimByWeight(state: BaseThreadState, charBudget: number): void {
        const messages = state.messages;
        if (messages.length === 0) return;

        const toolPairs = BaseNode.buildToolPairMap(messages);

        // Find latest user message
        let latestUserIdx = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'user') { latestUserIdx = i; break; }
        }

        // Calculate total chars of protected messages
        const protectedChars = messages.reduce((sum, m, i) => {
            if (m.role === 'system' || i === latestUserIdx) {
                const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
                return sum + c.length;
            }
            return sum;
        }, 0);

        const budgetForRest = charBudget - protectedChars;
        if (budgetForRest <= 0) return;

        // Walk from newest to oldest, keep until budget exhausted.
        // Tool pairs are kept/dropped atomically.
        const kept = new Set<number>();
        const visited = new Set<number>();
        let usedBudget = 0;

        for (let i = messages.length - 1; i >= 0; i--) {
            if (visited.has(i)) continue;
            const m = messages[i];
            if (m.role === 'system' || i === latestUserIdx) {
                kept.add(i);
                visited.add(i);
                continue;
            }

            // If this message is part of a tool pair, measure both together
            const pairedIdx = toolPairs.get(i);
            if (pairedIdx !== undefined && !visited.has(pairedIdx)) {
                const c1 = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
                const p = messages[pairedIdx];
                const c2 = typeof p.content === 'string' ? p.content : JSON.stringify(p.content);
                const pairSize = c1.length + c2.length;
                if (usedBudget + pairSize <= budgetForRest) {
                    kept.add(i);
                    kept.add(pairedIdx);
                    usedBudget += pairSize;
                }
                visited.add(i);
                visited.add(pairedIdx);
            } else {
                const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
                if (usedBudget + content.length <= budgetForRest) {
                    kept.add(i);
                    usedBudget += content.length;
                }
                visited.add(i);
            }
        }

        const before = messages.length;
        state.messages = messages.filter((_, i) => kept.has(i));
        const after = state.messages.length;

        if (before !== after) {
            console.log(`[${this.name}] fastTrimByWeight: ${before} → ${after} messages`);
        }
    }

    /**
     * Unified chat: takes state + new system prompt + user message.
     * - Replaces last system prompt (or appends new one)
     * - Appends user message
     * - Calls primary LLM
     * - On any error/failure → fallback to local Ollama if remote
     * - Appends assistant response to state.messages
     * - Parses JSON if format='json'
     * - No raw response logging
     */
    protected async normalizedChat(
        state: BaseThreadState,
        systemPrompt: string,
        options: LLMCallOptions = {}
    ): Promise<NormalizedResponse | null> {
        
        this.llm = await getPrimaryService();

        const nodeRunContext = this.createNodeRunContext(state, {
            systemPrompt,
            policy: options.nodeRunPolicy,
        });

        const callToolAccessPolicy = this.buildToolAccessPolicyForCall(options);
        const messages = [...nodeRunContext.messages];

        // Check for abort before making LLM calls
        throwIfAborted(state, 'Chat operation aborted');
        
        // Build dynamic LLM tools: meta category + found tools (set by browse_tools if found)
        // Skip tool loading if tools are explicitly disabled
        let llmTools: any[] = [];
        if (!options.disableTools) {
          llmTools = (state as any).llmTools;
          if (!llmTools && state.foundTools?.length) {
            // Fallback: convert foundTools to LLM format if llmTools wasn't set
            const metaLLMTools = await toolRegistry.getLLMToolsFor(await toolRegistry.getToolsByCategory("meta"));
            const foundLLMTools = await Promise.all(state.foundTools.map((tool: any) => toolRegistry.convertToolToLLM(tool.name)));
            llmTools = [...metaLLMTools, ...foundLLMTools];
          }
          if (!llmTools) {
            // Final fallback to just meta tools
            llmTools = await toolRegistry.getLLMToolsFor(await toolRegistry.getToolsByCategory("meta"));
          }

          const filtered = await this.filterLLMToolsByAccessPolicy(llmTools, options);
          llmTools = filtered.tools;
        }

        const previousToolAccessPolicy = (state.metadata as any).__toolAccessPolicy;
        (state.metadata as any).__toolAccessPolicy = callToolAccessPolicy;

        const conversationId = typeof state.metadata.threadId === 'string' ? state.metadata.threadId : undefined;
        const nodeName = this.name;
        const previousRunContext = this.currentNodeRunContext;
        this.currentNodeRunContext = nodeRunContext;
        try {
            // Primary attempt
            state.metadata.hadToolCalls = false;
            state.metadata.hadUserMessages = false;
            let reply: NormalizedResponse | null = await this.llm.chat(messages, {
                maxTokens: options.maxTokens,
                format: options.format,
                temperature: options.temperature,
                signal: (state as any).metadata?.__abort?.signal,
                tools: llmTools,
                conversationId,
                nodeName,
            });

            if (!reply) throw new Error('No response from primary LLM');

            // Extract and dispatch thinking content before appending the response
            this.extractAndDispatchThinking(state, reply);

            // Append to state — stores native tool_use content arrays when present
            this.appendResponse(state, reply.content, reply.metadata.rawProviderContent);

            // Send token information to AgentPersona
            this.dispatchTokenInfoToAgentPersona(state, reply);
            
            // Handle tool calls using the unified executeToolCalls method
            const toolCalls = reply.metadata.tool_calls || [];
            if (toolCalls.length) {
                console.log(`[${this.name}] Processing ${toolCalls.length} tool calls via executeToolCalls`);
                await this.executeToolCalls(state, toolCalls);
            }

            this.triggerBackgroundStateMaintenance(state);

            return reply;
        } catch (err) {
            if ((err as any)?.name === 'AbortError') throw err;

            console.warn(`[${this.name}:BaseNode] Primary LLM failed:`, err instanceof Error ? err.message : String(err));

            // Fallback to secondary provider
            try {
                const secondary = await getSecondaryService();
                await secondary.initialize();
                if (secondary.isAvailable()) {
                    const chatMessages = messages.filter(msg =>
                        ['system', 'user', 'assistant'].includes(msg.role)
                    ) as ChatMessage[];
                    const reply = await secondary.chat(chatMessages, {
                        signal: options.signal,
                        temperature: options.temperature,
                        maxTokens: options.maxTokens,
                        format: options.format,
                        conversationId,
                        nodeName,
                    });
                    if (reply) {
                        this.appendResponse(state, reply.content, reply.metadata.rawProviderContent);
                        this.triggerBackgroundStateMaintenance(state);
                        return reply;
                    }
                }
            } catch (fallbackErr) {
                console.error(`[${this.name}:BaseNode] Secondary provider fallback failed:`, fallbackErr);
            }

            return null;
        } finally {
            this.currentNodeRunContext = previousRunContext;
            (state.metadata as any).__toolAccessPolicy = previousToolAccessPolicy;
        }
    }

    private buildToolAccessPolicyForCall(options: LLMCallOptions): {
        allowedCategories: string[] | null;
        allowedToolNames: string[] | null;
    } {
        const allowedCategories = options.allowedToolCategories?.length
            ? [...new Set(options.allowedToolCategories)]
            : null;
        const allowedToolNames = options.allowedToolNames?.length
            ? [...new Set(options.allowedToolNames)]
            : null;

        return {
            allowedCategories,
            allowedToolNames,
        };
    }

    private async filterLLMToolsByAccessPolicy(
        llmTools: any[],
        options: LLMCallOptions,
    ): Promise<{ tools: any[] }> {
        const hasRestrictions = Boolean(options.allowedToolCategories?.length || options.allowedToolNames?.length);

        if (!hasRestrictions || !Array.isArray(llmTools) || llmTools.length === 0) {
            return { tools: llmTools || [] };
        }

        const allowedToolNamesSet = options.allowedToolNames?.length
            ? new Set(options.allowedToolNames)
            : null;
        const allowedCategoriesSet = options.allowedToolCategories?.length
            ? new Set(options.allowedToolCategories)
            : null;
        const filteredTools: any[] = [];
        for (const llmTool of llmTools) {
            const toolName = llmTool?.function?.name;
            if (!toolName) {
                continue;
            }

            if (allowedToolNamesSet && !allowedToolNamesSet.has(toolName)) {
                continue;
            }

            const toolInstance = await toolRegistry.getTool(toolName);
            const category = String(toolInstance?.metadata?.category || '').trim();
            if (allowedCategoriesSet && !allowedCategoriesSet.has(category)) {
                continue;
            }

            filteredTools.push(llmTool);
        }

        return { tools: filteredTools };
    }

    protected getDefaultNodeRunPolicy(): Required<NodeRunPolicy> {
        return {
            messageSource: 'graph',
            persistAssistantToGraph: true,
        };
    }

    protected createNodeRunContext(
        state: BaseThreadState,
        input: {
            systemPrompt: string;
            policy?: NodeRunPolicy;
        },
    ): NodeRunContext {
        const defaults = this.getDefaultNodeRunPolicy();
        const policy: Required<NodeRunPolicy> = {
            ...defaults,
            ...(input.policy || {}),
        };

        const systemMessage: ChatMessage = {
            role: 'system',
            content: (input.systemPrompt ?? '').trim(),
        };

        const mergedMessages: ChatMessage[] = [
            ...(state.messages || []).filter(msg => msg.role !== 'system').map(msg => ({ ...msg })),
            systemMessage,
        ];

        return {
            runId: `${this.id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            nodeId: this.id,
            nodeName: this.name,
            messages: mergedMessages,
            toolTranscript: [],
            hadToolCalls: false,
            hadUserMessages: false,
            policy,
        };
    }

    /**
     * Clears out any thinking context
     * Parses JSON with our best attempt parser
     * 
     * @param raw 
     * @returns 
     */
    protected parseJson<T = unknown>(raw: string | null | undefined): T | null {
        // If it's already an object, return it as-is
        if (typeof raw === 'object') {
            return raw as T;
        }
        if (!raw || typeof raw !== 'string') return null;

        return parseJson(raw);
    }

    /**
     * Helper method to respond gracefully when abort is detected
     */
    protected async handleAbort(state: BaseThreadState, message?: string): Promise<void> {
        const abortMessage = message || "OK, I'm stopping everything. What do you need me to do?";
        this.wsChatMessage(state, abortMessage, 'assistant', 'progress');
    }

    /**
     * Optional: append assistant response to state.messages
     * rawProviderContent: raw content array from provider (e.g. Anthropic tool_use blocks).
     * When present and containing tool_use blocks, the native content array is stored directly
     * so buildRequestBody can pass it through as-is on subsequent turns.
     */
    protected async appendResponse(state: BaseThreadState, content: string, rawProviderContent?: any): Promise<void> {
        const contentStr = typeof content === 'string' ? content : JSON.stringify(content);
        const normalizedContent = contentStr.trim();

        // Determine if the raw provider content has tool_use blocks
        const hasToolUseBlocks = Array.isArray(rawProviderContent)
            && rawProviderContent.some((b: any) => b?.type === 'tool_use');

        // If pure tool_use response with no text, still store the native content
        if (!normalizedContent && !hasToolUseBlocks) {
            return;
        }

        // Use native content array when tool_use blocks are present
        const messageContent: any = hasToolUseBlocks ? rawProviderContent : normalizedContent;

        const messageMeta: Record<string, any> = {
            nodeId: this.id,
            timestamp: Date.now(),
        };

        if (this.currentNodeRunContext) {
            this.currentNodeRunContext.messages.push({
                role: 'assistant',
                content: normalizedContent || '',
                metadata: messageMeta,
            });
        }

        // Deduplicate — don't push if last message is identical string content
        if (typeof messageContent === 'string') {
            const lastGraphMessage = state.messages[state.messages.length - 1] as ChatMessage | undefined;
            if (
                lastGraphMessage?.role === 'assistant'
                && typeof lastGraphMessage.content === 'string'
                && lastGraphMessage.content.trim() === messageContent
            ) {
                return;
            }
        }

        state.messages.push({
            role: 'assistant',
            content: messageContent,
            metadata: messageMeta,
        });
        this.bumpStateVersion(state);
    }

    /**
     * Extract thinking/reasoning content from an LLM reply and dispatch it
     * to the AgentPersona chat as a 'thinking' kind message.
     * Sources:
     *   1. reply.metadata.reasoning (Anthropic thinking/reasoning blocks)
     *   2. <thinking>...</thinking> tags in reply.content (other providers)
     * Mutates reply.content in-place to strip thinking tags.
     */
    protected extractAndDispatchThinking(state: BaseThreadState, reply: NormalizedResponse): void {
        let thinkingText = '';

        // Source 1: Anthropic reasoning metadata
        if (reply.metadata.reasoning) {
            thinkingText = reply.metadata.reasoning.trim();
        }

        // Source 2: <thinking> tags in content
        const thinkingTagRegex = /<thinking>([\s\S]*?)<\/thinking>/gi;
        const tagMatches = reply.content.match(thinkingTagRegex);
        if (tagMatches) {
            const extracted = tagMatches
                .map(m => m.replace(/<\/?thinking>/gi, '').trim())
                .filter(Boolean)
                .join('\n');
            if (extracted) {
                thinkingText = thinkingText ? `${thinkingText}\n${extracted}` : extracted;
            }
            // Strip thinking tags from the content
            reply.content = reply.content.replace(thinkingTagRegex, '').trim();
        }

        if (!thinkingText) {
            return;
        }

        // Dispatch as a 'thinking' kind message to the frontend
        this.wsChatMessage(state, thinkingText, 'assistant', 'thinking');
    }

    /**
     * Connect to a WebSocket server and optionally register a message handler
     * @param connectionId Unique identifier for this connection
     * @param url WebSocket URL (defaults to ws://localhost:8080/)
     * @param onMessage Optional handler for incoming messages
     * @returns true if connection initiated
     */
    protected connectWebSocket(
        connectionId: string,
        onMessage?: WebSocketMessageHandler
    ): boolean {
        const wsService = getWebSocketClientService();
        const connected = wsService.connect(connectionId);

        if (connected && onMessage) {
            // Small delay to allow connection to establish before registering handler
            setTimeout(() => {
                wsService.onMessage(connectionId, onMessage);
            }, 100);
        }

        return connected;
    }

    /**
     * Send a message to a WebSocket connection
     * @param connectionId Connection identifier
     * @param message Message to send (object or string)
     * @returns true if sent successfully
     */
    protected async dispatchToWebSocket(connectionId: string, message: unknown): Promise<boolean> {
        const wsService = getWebSocketClientService();
        return await wsService.send(connectionId, message);
    }

    /**
     * Register a handler for WebSocket messages
     * @param connectionId Connection identifier
     * @param handler Callback function for incoming messages
     * @returns Unsubscribe function or null if connection not found
     */
    protected listenToWebSocket(
        connectionId: string,
        handler: WebSocketMessageHandler,
    ): (() => void) | null {
        const wsService = getWebSocketClientService();
        return wsService.onMessage(connectionId, handler);
    }

    /**
     * Disconnect from a WebSocket server
     * @param connectionId Connection identifier
     */
    protected disconnectWebSocket(connectionId: string): void {
        const wsService = getWebSocketClientService();
        wsService.disconnect(connectionId);
    }

    /**
     * Check if a WebSocket connection is active
     * @param connectionId Connection identifier
     */
    protected isWebSocketConnected(connectionId: string): boolean {
        const wsService = getWebSocketClientService();
        return wsService.isConnected(connectionId);
    }


    /**
     * Dispatch token information to AgentPersona via WebSocket
     */
    private async dispatchTokenInfoToAgentPersona(state: BaseThreadState, reply: NormalizedResponse): Promise<void> {
        const wsChannel = state.metadata.wsChannel || DEFAULT_WS_CHANNEL;
        const sent = await this.dispatchToWebSocket(wsChannel, {
            type: 'token_info',
            data: {
                tokens_used: reply.metadata.tokens_used,
                prompt_tokens: reply.metadata.prompt_tokens,
                completion_tokens: reply.metadata.completion_tokens,
                time_spent: reply.metadata.time_spent,
                threadId: state.metadata.threadId,
                nodeId: this.name,
            },
            timestamp: Date.now(),
        });

        if (!sent) {
            console.warn(`[BaseNode:${this.name}] Failed to send token info via WebSocket`);
        }
    }

    /**
     * Emit a chat message to the UI dashboard via WebSocket
     * Connection ID is read from state.metadata.wsChannel (defaults to 'chat-controller')
     * @param state BaseThreadState containing the connection ID in metadata
     * @param content Message content to display
     * @param role 'assistant' | 'system' - defaults to 'assistant'
     * @param kind Optional UI kind tag - defaults to 'progress'
     * @returns true if message was sent via WebSocket
     */
    protected async wsChatMessage(
        state: BaseThreadState,
        content: string,
        role: 'assistant' | 'system' = 'assistant',
        kind: string = 'progress',
    ): Promise<boolean> {
        if (!content.trim()) {
            return false;
        }

        // Get connection ID from state or use default
        const connectionId = (state.metadata.wsChannel as string) || DEFAULT_WS_CHANNEL;

        // Ensure WebSocket connection exists
        if (!this.isWebSocketConnected(connectionId)) {
            console.log(`[${this.name}:BaseNode] Not Connected`)
            this.connectWebSocket(connectionId);
        }

        // Send via WebSocket
        const sent = await this.dispatchToWebSocket(connectionId, {
            type: 'assistant_message',
            data: {
                content: content.trim(),
                role,
                kind,
                timestamp: Date.now(),
            },
        });

        if (!sent) {
            console.warn(`[Agent:${this.name}] Failed to send chat message via WebSocket`);
        } else {
            state.metadata.hadUserMessages = true;
        }

        return sent;
    }

    /**
     * Emit a tool call event to create/update tool cards in the UI
     * @param state BaseThreadState containing the WebSocket channel
     * @param toolRunId Unique identifier for this tool execution
     * @param toolName Name of the tool being called
     * @param args Arguments passed to the tool
     * @param kind Optional kind of the event (e.g., 'thinking', 'info')
     * @returns true if event was sent via WebSocket
     */
    protected async emitToolCallEvent(
        state: BaseThreadState,
        toolRunId: string,
        toolName: string,
        args: Record<string, any>,
        kind?: string
    ): Promise<boolean> {
        const connectionId = (state.metadata.wsChannel as string) || DEFAULT_WS_CHANNEL;
        
        return await this.dispatchToWebSocket(connectionId, {
            type: 'progress',
            data: {
                phase: 'tool_call',
                toolRunId,
                toolName,
                args,
                kind
            },
            timestamp: Date.now()
        });
    }

    /**
     * Emit a tool result event to update tool card status in the UI
     * @param state BaseThreadState containing the WebSocket channel
     * @param toolRunId Same ID from the tool_call event
     * @param success Whether the tool execution succeeded
     * @param error Optional error message if success is false
     * @param result Optional result data if success is true
     * @returns true if event was sent via WebSocket
     */
    protected async emitToolResultEvent(
        state: BaseThreadState,
        toolRunId: string,
        success: boolean,
        error?: string,
        result?: any
    ): Promise<boolean> {
        const connectionId = (state.metadata.wsChannel as string) || DEFAULT_WS_CHANNEL;
        
        return await this.dispatchToWebSocket(connectionId, {
            type: 'progress',
            data: {
                phase: 'tool_result',
                toolRunId,
                success,
                error,
                result
            },
            timestamp: Date.now()
        });
    }

    private stableStringify(value: unknown): string {
        const normalize = (input: unknown): unknown => {
            if (Array.isArray(input)) {
                return input.map(item => normalize(item));
            }

            if (!input || typeof input !== 'object') {
                return input;
            }

            const record = input as Record<string, unknown>;
            const sortedKeys = Object.keys(record).sort((a, b) => a.localeCompare(b));
            const normalized: Record<string, unknown> = {};
            for (const key of sortedKeys) {
                normalized[key] = normalize(record[key]);
            }

            return normalized;
        };

        return JSON.stringify(normalize(value));
    }

    private buildToolRunDedupeKey(toolName: string, args: unknown): string {
        return `${toolName}:${this.stableStringify(args ?? {})}`;
    }

    private persistStructuredToolRunRecord(
        state: BaseThreadState,
        payload: {
            toolName: string;
            toolRunId: string;
            args: unknown;
            success: boolean;
            result?: unknown;
            error?: string;
        },
    ): void {
        const metadataAny = state.metadata as any;
        const dedupeKey = this.buildToolRunDedupeKey(payload.toolName, payload.args);
        const record = {
            toolName: payload.toolName,
            toolRunId: payload.toolRunId,
            dedupeKey,
            args: payload.args ?? {},
            success: payload.success,
            result: payload.result,
            error: payload.error,
            timestamp: Date.now(),
            nodeId: this.id,
            nodeName: this.name,
        };

        if (!Array.isArray(metadataAny.__toolRuns)) {
            metadataAny.__toolRuns = [];
        }
        if (!metadataAny.__toolRunIndex || typeof metadataAny.__toolRunIndex !== 'object') {
            metadataAny.__toolRunIndex = {};
        }
        metadataAny.__toolRuns.push(record);
        metadataAny.__toolRunIndex[dedupeKey] = record;
        this.bumpStateVersion(state);
    }


    /**
     * Execute multiple tool calls, append results as 'tool' messages, return results array.
     * - Appends each result immediately after execution (LLM sees sequential feedback)
     * - Uses role: 'tool' + name/tool_call_id for API compatibility
     * - Failed tools include help info
     * - Minimal logging (no full JSON dump)
     */
    protected async executeToolCalls(
        state: BaseThreadState,
        toolCalls: Array<{name: string, id?: string, args: any}>,
        allowedTools?: string[]
    ): Promise<Array<{ toolName: string; success: boolean; result?: unknown; error?: string }>> {
        if (!toolCalls?.length) return [];

        state.metadata.hadToolCalls = true;
        if (this.currentNodeRunContext) {
            this.currentNodeRunContext.hadToolCalls = true;
        }

        // Check for abort before processing tools
        throwIfAborted(state, 'Tool execution aborted');

        const results: Array<{ toolName: string; success: boolean; result?: unknown; error?: string }> = [];

        for (const call of toolCalls) {
            // Check for abort before each tool execution
            throwIfAborted(state, `Tool execution aborted before ${call.name}`);
            
            // Use call.id or generate unique tool run ID for this execution
            const toolRunId = call.id || `${call.name}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            const toolName = call.name;
            const args = call.args;

            const policyBlockReason = await this.getToolPolicyBlockReason(state, toolName);
            if (policyBlockReason) {
                await this.emitToolCallEvent(state, toolRunId, toolName, args);
                await this.emitToolResultEvent(state, toolRunId, false, policyBlockReason);

                await this.appendToolResultMessage(state, toolName, {
                    toolName,
                    success: false,
                    error: policyBlockReason,
                    toolCallId: toolRunId
                });
                this.persistStructuredToolRunRecord(state, {
                    toolName,
                    toolRunId,
                    args,
                    success: false,
                    error: policyBlockReason,
                });
                results.push({ toolName, success: false, error: policyBlockReason });
                if (this.currentNodeRunContext) {
                    this.currentNodeRunContext.toolTranscript.push({
                        toolName,
                        success: false,
                        error: policyBlockReason,
                    });
                }
                continue;
            }

            // Disallowed → emit tool call and failure, then continue
            if (allowedTools?.length && !allowedTools.includes(toolName)) {
                await this.emitToolCallEvent(state, toolRunId, toolName, args);
                await this.emitToolResultEvent(state, toolRunId, false, `Tool not allowed in this node: ${toolName}`);
                
                await this.appendToolResultMessage(state, toolName, {
                    toolName,
                    success: false,
                    error: `Tool not allowed in this node: ${toolName}`,
                    toolCallId: toolRunId
                });
                this.persistStructuredToolRunRecord(state, {
                    toolName,
                    toolRunId,
                    args,
                    success: false,
                    error: `Tool not allowed in this node: ${toolName}`,
                });
                results.push({ toolName, success: false, error: 'Not allowed' });
                if (this.currentNodeRunContext) {
                    this.currentNodeRunContext.toolTranscript.push({
                        toolName,
                        success: false,
                        error: `Tool not allowed in this node: ${toolName}`,
                    });
                }
                continue;
            }

            try {
                const tool = await toolRegistry.getTool(toolName);
                
                // Emit tool call event before execution
                await this.emitToolCallEvent(state, toolRunId, toolName, args);

                try {
                    // Inject WebSocket capabilities into the tool
                    if (tool instanceof BaseTool) {
                        tool.setState(state);

                        tool.sendChatMessage = (content: string, kind = "progress") => 
                        this.wsChatMessage(state, content, "assistant", kind);
                        
                        tool.emitProgress = async (data: any) => {
                            await this.dispatchToWebSocket(state.metadata.wsChannel || DEFAULT_WS_CHANNEL, {
                                type: "progress_update",
                                data: { ...data, kind: 'progress' },
                                timestamp: Date.now()
                            });
                        };
                    }

                    const result = await tool.invoke(args);
                    const toolSuccess = result?.success === true;
                    const toolError = typeof result?.error === 'string'
                        ? result.error
                        : (!toolSuccess && typeof result?.result === 'string' ? result.result : undefined);

                    await this.emitToolResultEvent(state, toolRunId, toolSuccess, toolError, result);

                    await this.appendToolResultMessage(state, toolName, {
                        toolName,
                        success: toolSuccess,
                        result,
                        error: toolError,
                        toolCallId: toolRunId
                    });
                    this.persistStructuredToolRunRecord(state, {
                        toolName,
                        toolRunId,
                        args,
                        success: toolSuccess,
                        result,
                        error: toolError,
                    });

                    results.push({
                        toolName,
                        success: toolSuccess,
                        result,
                        error: toolError
                    });
                    if (this.currentNodeRunContext) {
                        this.currentNodeRunContext.toolTranscript.push({
                            toolName,
                            success: toolSuccess,
                            result,
                            error: toolError,
                        });
                    }
                } catch (err: any) {
                    const error = err.message || String(err);
                    
                    // Emit tool result event on error
                    await this.emitToolResultEvent(state, toolRunId, false, error);
                    
                    await this.appendToolResultMessage(state, toolName, {
                        toolName,
                        success: false,
                        error,
                        toolCallId: toolRunId
                    });
                    this.persistStructuredToolRunRecord(state, {
                        toolName,
                        toolRunId,
                        args,
                        success: false,
                        error,
                    });
                    results.push({ toolName, success: false, error });
                    if (this.currentNodeRunContext) {
                        this.currentNodeRunContext.toolTranscript.push({
                            toolName,
                            success: false,
                            error,
                        });
                    }
                }
            } catch {
                await this.emitToolCallEvent(state, toolRunId, toolName, args);
                await this.emitToolResultEvent(state, toolRunId, false, `Unknown tool: ${toolName}`);
                
                await this.appendToolResultMessage(state, toolName, {
                    toolName,
                    success: false,
                    error: `Unknown tool: ${toolName}`,
                    toolCallId: toolRunId
                });
                this.persistStructuredToolRunRecord(state, {
                    toolName,
                    toolRunId,
                    args,
                    success: false,
                    error: `Unknown tool: ${toolName}`,
                });
                results.push({ toolName, success: false, error: 'Unknown tool' });
                if (this.currentNodeRunContext) {
                    this.currentNodeRunContext.toolTranscript.push({
                        toolName,
                        success: false,
                        error: 'Unknown tool',
                    });
                }
                continue;
            }
        }

        return results;
    }

    private async getToolPolicyBlockReason(state: BaseThreadState, toolName: string): Promise<string | null> {
        const policy = (state.metadata as any).__toolAccessPolicy as {
            allowedCategories: string[] | null;
            allowedToolNames: string[] | null;
        } | undefined;

        if (!policy) {
            return null;
        }

        const allowedToolNames = policy.allowedToolNames;
        if (allowedToolNames?.length && !allowedToolNames.includes(toolName)) {
            return `Tool not allowed by name policy: ${toolName}`;
        }

        let toolInstance: any;
        try {
            toolInstance = await toolRegistry.getTool(toolName);
        } catch {
            return null;
        }

        const category = String(toolInstance?.metadata?.category || '').trim();
        const allowedCategories = policy.allowedCategories;
        if (allowedCategories?.length && !allowedCategories.includes(category)) {
            return `Tool category not allowed in this node: ${toolName} (category: ${category || 'unknown'})`;
        }

        return null;
    }

    /**
     * Append tool result to state.messages as a proper role:'user' message with
     * native tool_result content blocks (matching the tool_use_id from the
     * assistant's tool_use call).  This is the format Anthropic/OpenAI expect
     * and it persists across graph cycles so the LLM always sees the full
     * tool_use → tool_result conversation.
     */
    public async appendToolResultMessage(
        state: BaseThreadState,
        action: string,
        result: ToolResult
    ): Promise<void> {
        if (action === 'emit_chat_message') {
            return;
        }

        // --- Format the result payload into a readable string ---

        const formatPayload = (payload: unknown, maxLen?: number): string => {
            if (payload == null) return 'null';

            let parsed = payload;
            if (typeof parsed === 'string') {
                const trimmed = parsed.trim();
                if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
                    try { parsed = JSON.parse(trimmed); } catch { /* keep as string */ }
                }
            }

            // Unwrap tool envelope: { result: ..., toolName, success, ... } → just result
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                const record = parsed as Record<string, any>;
                if ('result' in record && ('toolName' in record || 'tool' in record || 'success' in record || 'toolCallId' in record)) {
                    parsed = record.result;
                }
            }

            const serialized = typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2);
            if (maxLen && serialized.length > maxLen) {
                return `${serialized.substring(0, maxLen)}...`;
            }
            return serialized;
        };

        const contentText = formatPayload(result.result, 5000);
        const errorText = String(result.error || 'unknown error').trim();
        const showDetails = contentText.trim().length > 0 && contentText.trim() !== errorText;

        const resultContent = result.success
            ? `tool: ${action}\nresult:\n${contentText}`
            : `tool: ${action}\nerror: ${errorText}${showDetails ? `\nresult:\n${contentText}` : ''}`;

        const toolCallId = result.toolCallId || `${action}_${Date.now()}`;

        // --- 1. Node run context (current LLM turn visibility) ---
        if (this.currentNodeRunContext) {
            this.currentNodeRunContext.messages.push({
                role: 'tool',
                content: resultContent,
                name: action,
                tool_call_id: toolCallId,
                metadata: {
                    nodeId: this.id,
                    nodeName: this.name,
                    kind: 'tool_result',
                    toolName: action,
                    success: result.success,
                    timestamp: Date.now(),
                },
            } as ChatMessage);
        }

        // --- 2. Persist to state.messages as native tool_result (user role) ---
        // The assistant's tool_use message was already stored by appendResponse
        // with the native content array. Now store the matching tool_result.
        //
        // Anthropic requires ALL tool_result blocks for a multi-tool_use assistant
        // message to appear in the SAME immediately-following user message.
        // So if the last message is already a user tool_result message AND the
        // assistant message before it contains our tool_use_id, merge into it.
        const newToolResultBlock = {
            type: 'tool_result',
            tool_use_id: toolCallId,
            content: resultContent,
        };

        const lastMsg = state.messages[state.messages.length - 1];
        const secondToLast = state.messages.length >= 2 ? state.messages[state.messages.length - 2] : null;

        const lastIsToolResult = lastMsg?.role === 'user'
            && Array.isArray(lastMsg.content)
            && lastMsg.content.some((b: any) => b?.type === 'tool_result');

        const prevAssistantHasOurToolUse = secondToLast?.role === 'assistant'
            && Array.isArray(secondToLast.content)
            && secondToLast.content.some((b: any) => b?.type === 'tool_use' && b?.id === toolCallId);

        if (lastIsToolResult && prevAssistantHasOurToolUse) {
            // Merge into existing user tool_result message
            (lastMsg.content as unknown as any[]).push(newToolResultBlock);
        } else {
            state.messages.push({
                role: 'user',
                content: [newToolResultBlock],
                metadata: {
                    nodeId: this.id,
                    nodeName: this.name,
                    kind: 'tool_result',
                    toolName: action,
                    success: result.success,
                    timestamp: Date.now(),
                },
            } as any);
        }

        this.bumpStateVersion(state);
    }

}
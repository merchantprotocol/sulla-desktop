import type { BaseThreadState, NodeResult } from './Graph';
import type { ToolResult, ThreadState } from '../types';
import path from 'node:path'; // used by enrichPrompt for active_projects_file
import type { WebSocketMessageHandler } from '../services/WebSocketClientService';
import { getCurrentMode, getLocalService, getService, getPrimaryService, getSecondaryService } from '../languagemodels';
import { parseJson } from '../services/JsonParseService';
import { getWebSocketClientService } from '../services/WebSocketClientService';
import { SullaSettingsModel } from '../database/models/SullaSettingsModel';
import { BaseLanguageModel, ChatMessage, NormalizedResponse, FinishReason, type StreamCallbacks } from '../languagemodels/BaseLanguageModel';
import { throwIfAborted } from '../services/AbortService';
import { toolRegistry } from '../tools/registry';
import { resolveSullaProjectsDir, resolveSullaSkillsDir, resolveSullaAgentsDir, resolveSullaCodebaseDir, findAgentDir, resolveSullaHomeDir } from '../utils/sullaPaths';
import { INTEGRATIONS_INSTRUCTIONS_BLOCK } from '../prompts/environment';
import { stripProtocolTags } from '../utils/stripProtocolTags';
import { ChatController, type ChatMode } from '../controllers/ChatController';
import { ToolExecutor } from '../controllers/ToolExecutor';
import type { StreamContext } from '../controllers/Extractor';
import fs from 'node:fs';
import { SystemPromptBuilder, type PromptBuildContext, type AgentConfig, type AnthropicSystemBlock } from '../prompts/SystemPromptBuilder';
import '../prompts/sections/index'; // Register all sections on import

// ============================================================================
// DEFAULT SETTINGS
// ============================================================================

const DEFAULT_WS_CHANNEL = 'heartbeat';

export const JSON_ONLY_RESPONSE_INSTRUCTIONS = `When you respond it will be parsed as JSON and ONLY the following object will be read.
Any text outside this exact structure will break downstream parsing.\nRespond ONLY with this valid JSON — nothing before, nothing after, no fences, no commentary:`;

export const TOOLS_RESPONSE_JSON = `  "tools": [
    ["tool_name", "arg1", "arg2"] - run any tool with exec form
    ["emit_chat_message", "Respond to the users inquiry"]
  ],`;


// ============================================================================
// INTERFACES AND TYPES
// ============================================================================

export interface LLMCallOptions {
  model?:                 string;
  maxTokens?:             number;
  format?:                'json' | undefined;
  temperature?:           number;
  signal?:                AbortSignal;
  disableTools?:          boolean;
  nodeRunPolicy?:         NodeRunPolicy;
  allowedToolCategories?: string[];
  allowedToolNames?:      string[];
}

export interface NodeRunPolicy {
  messageSource?:           'graph';
  persistAssistantToGraph?: boolean;
}

export interface NodeRunContext {
  runId:           string;
  nodeId:          string;
  nodeName:        string;
  messages:        ChatMessage[];
  toolTranscript:  { toolName: string; success: boolean; result?: unknown; error?: string }[];
  hadToolCalls:    boolean;
  hadUserMessages: boolean;
  policy:          Required<NodeRunPolicy>;
}

export interface LLMResponse {
  content: string | Record<string, any>;
  model:   string;
}

export interface PromptEnrichmentOptions {
  includeSoul?:        boolean;
  includeAwareness?:   boolean;
  includeEnvironment?: boolean;
  includeMemory?:      boolean;
  includeTools?:       boolean;
  /** Prompt mode for section-based builder: full (main agent), minimal (subagents), local (condensed for local LLMs), none (pass-through) */
  promptMode?:         'full' | 'minimal' | 'local' | 'none';
  /** Whether this is the heartbeat (autonomous) agent */
  isHeartbeat?:        boolean;
  /** Chat mode override for voice section injection */
  chatMode?:           ChatMode;
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
    ? `You are Sulla Desktop, and you like to be called ${ botName }\nThe Human's name is: ${ primaryUserName }\n\n`
    : `You are Sulla Desktop, and you like to be called ${ botName }\n\n`;

  return prefix + prompt;
}

/**
 * Build a filtered integrations index for the agent's prompt context.
 * Shows only integrations the agent is allowed to use, with their config paths,
 * descriptions, categories, and available endpoints.
 *
 * @param allowedIntegrations - slugs from config.yaml integrations field.
 *   Empty array = no integrations. ["*"] = all integrations.
 */
async function buildIntegrationsIndex(allowedIntegrations?: string[]): Promise<string> {
  if (!allowedIntegrations || allowedIntegrations.length === 0) {
    return '';
  }

  const allowAll = allowedIntegrations.includes('*');

  try {
    // Get catalog metadata (descriptions, categories)
    const { integrations: catalog } = await import('../integrations/catalog');

    // Get configApi loader (endpoints, config file paths)
    const { getIntegrationConfigLoader } = await import('../integrations/configApi');
    const loader = getIntegrationConfigLoader();
    const availableSlugs = loader.getAvailableIntegrations();

    // Get connection status
    const { getIntegrationService } = await import('../services/IntegrationService');
    const service = getIntegrationService();
    await service.initialize();

    // Build the combined set of slugs to show
    const allSlugs = new Set([
      ...Object.keys(catalog),
      ...availableSlugs,
    ]);

    // Filter by allowlist
    const filteredSlugs = [...allSlugs].filter(slug =>
      allowAll || allowedIntegrations.includes(slug),
    ).sort();

    if (filteredSlugs.length === 0) {
      return '';
    }

    // Group by category
    const byCategory = new Map<string, string[]>();
    const lines: string[] = [];

    for (const slug of filteredSlugs) {
      const catalogEntry = catalog[slug];
      const client = loader.getClient(slug);
      const status = await service.getConnectionStatus(slug);

      const name = catalogEntry?.name || client?.name || slug;
      const description = catalogEntry?.description || '';
      const category = catalogEntry?.category || 'Uncategorized';
      const connected = status.connected ? 'Connected' : 'Not connected';

      // Build endpoints list from configApi
      let endpointsList = '';
      if (client) {
        const epNames = client.endpointNames;
        if (epNames.length > 0) {
          const epDescriptions = epNames.map((epName: string) => {
            const ep = client.getEndpoint(epName);
            const desc = ep?.endpoint?.description ? ` — ${ ep.endpoint.description }` : '';
            const method = ep?.endpoint?.method || 'GET';
            return `    - \`${ epName }\` (${ method })${ desc }`;
          });
          endpointsList = '\n' + epDescriptions.join('\n');
        }
      }

      // Config path
      const integration = loader.getIntegration(slug);
      const configPath = integration?.dir ? `\`${ integration.dir }/\`` : `\`~/sulla/integrations/${ slug }/\``;

      const line = `- **${ name }** (\`${ slug }\`) [${ connected }] — ${ description || 'No description' }\n  Config: ${ configPath }${ endpointsList }`;

      if (!byCategory.has(category)) {
        byCategory.set(category, []);
      }
      byCategory.get(category)!.push(line);
    }

    // Format by category
    for (const [category, entries] of [...byCategory.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push(`#### ${ category }`);
      lines.push(...entries);
      lines.push('');
    }

    return lines.join('\n');
  } catch (err) {
    console.error('[BaseNode] Failed to build integrations index:', err);
    return '';
  }
}

/**
 * Build the template variable map used to substitute {{...}} placeholders
 * in agent prompt files and the environment prompt.
 */
async function getTemplateVariables(): Promise<Record<string, string>> {
  const botName = await SullaSettingsModel.get('botName', 'Sulla');
  const primaryUserName = await SullaSettingsModel.get('primaryUserName', '');
  const projectsDir = resolveSullaProjectsDir();
  const skillsDir = resolveSullaSkillsDir();
  const agentsDir = resolveSullaAgentsDir();

  const now = new Date();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown';
  const formattedTime = now.toLocaleString('en-US', {
    timeZone,
    weekday: 'long',
    year:    'numeric',
    month:   'long',
    day:     'numeric',
    hour:    '2-digit',
    minute:  '2-digit',
    second:  '2-digit',
    hour12:  true,
  });

  // Tool categories
  const categoriesWithDesc = toolRegistry.getCategoriesWithDescriptions();
  const categoriesText = categoriesWithDesc.map(({ category, description }: { category: string; description: string }) =>
    `- ${ category }: ${ description }`).join('\n');

  // Skills index
  let skillsIndex = '_No skills registered yet._';
  try {
    const { skillsRegistry } = await import('../database/registry/SkillsRegistry');
    const summaries = await skillsRegistry.getSkillSummaries();
    if (summaries && summaries.length > 0) {
      const lines = summaries.map((s: any) => {
        const trigger = Array.isArray(s.triggers) && s.triggers.length > 0
          ? ` — use when: ${ s.triggers.join('; ') }`
          : '';
        return `- **${ s.name }** (\`${ s.slug }\`)${ s.description ? `: ${ s.description }` : '' }${ trigger }`;
      });
      skillsIndex = lines.join('\n');
    }
  } catch { /* registry not available */ }

  // Installed extensions
  let installedExtensions = '';
  try {
    const { getExtensionService } = await import('../services/ExtensionService');
    const svc = getExtensionService();
    await svc.initialize();
    const installed = await svc.fetchInstalledExtensions();
    if (installed.length > 0) {
      const lines = installed.map((ext: any) => {
        const title = ext.labels?.['org.opencontainers.image.title'] ?? ext.id;
        const desc = ext.labels?.['org.opencontainers.image.description'] ?? '';
        const urls = ext.extraUrls.map((u: any) => `${ u.label }: ${ u.url }`).join(', ');
        return `- **${ title }** (${ ext.id }) v${ ext.version }${ urls ? ` — ${ urls }` : '' }${ desc ? ` — ${ desc }` : '' }`;
      });
      installedExtensions = `\n#### Currently Installed Extensions (active products you can use)\nThese are running locally and our preferred system for you to interact with via their web UIs, APIs, database, and Docker tools:\n${ lines.join('\n') }`;
    }
  } catch { /* extension service not available */ }

  return {
    '{{formattedTime}}':        formattedTime,
    '{{timeZone}}':             timeZone,
    '{{primaryUserName}}':      primaryUserName || '',
    '{{botName}}':              botName,
    '{{sulla_home}}':           resolveSullaHomeDir(),
    '{{codebase_dir}}':         resolveSullaCodebaseDir(),
    '{{projects_dir}}':         projectsDir,
    '{{skills_dir}}':           skillsDir,
    '{{agents_dir}}':           agentsDir,
    '{{active_projects_file}}': path.join(projectsDir, 'ACTIVE_PROJECTS.md'),
    '{{skills_index}}':         skillsIndex,
    '{{tool_categories}}':      categoriesText,
    '{{installed_extensions}}':  installedExtensions,
  };
}

/** Apply template variable substitution to a string. */
function applyTemplateVars(text: string, vars: Record<string, string>): string {
  let result = text;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(key, value);
  }
  return result;
}

/** Maximum chars per bootstrap/agent .md file before truncation */
const BOOTSTRAP_MAX_CHARS_PER_FILE = 20_000;
/** Maximum total chars for all bootstrap/agent .md files combined */
const BOOTSTRAP_TOTAL_MAX_CHARS = 150_000;

/**
 * Truncate a file's content if it exceeds the per-file limit.
 * Keeps first 40% and last 40% with a truncation marker.
 */
function truncateBootstrapContent(content: string, maxChars: number = BOOTSTRAP_MAX_CHARS_PER_FILE): string {
  if (content.length <= maxChars) return content;
  const headSize = Math.floor(maxChars * 0.4);
  const tailSize = Math.floor(maxChars * 0.4);
  const truncated = content.length - headSize - tailSize;
  return `${ content.slice(0, headSize) }\n\n[... ${ truncated } chars truncated ...]\n\n${ content.slice(-tailSize) }`;
}

/** Cache for loaded agent prompt files (agentId -> combined markdown content). */
const agentPromptCache = new Map<string, { content: string; loadedAt: number }>();
const AGENT_PROMPT_CACHE_TTL = 30_000; // 30s — reload agent files periodically

/**
 * Result of loading agent .md files, split into section overrides
 * and generic prompt content for the section-based builder.
 */
export interface AgentPromptLoadResult {
  /** Agent name from config.yaml */
  agentName: string;
  /** Generic prompt content (non-override .md files combined) */
  genericPrompt: string;
  /** Section overrides: section_id → file content */
  sectionOverrides: Map<string, string>;
  /** Sections to exclude (from config.yaml exclude_sections) */
  excludeSections: string[];
  /** Parsed config.yaml */
  config: AgentConfig | null;
}

/** Cache for loaded agent prompt load results */
const agentPromptLoadCache = new Map<string, { result: AgentPromptLoadResult; loadedAt: number }>();

/**
 * Load agent .md files and split them into section overrides vs generic prompt content.
 * Files whose basename (minus .md) matches a registered section ID become overrides.
 * All other .md files are concatenated as generic prompt content.
 */
async function loadAgentPromptData(agentId: string): Promise<AgentPromptLoadResult | null> {
  if (!agentId) return null;

  // Check cache
  const cached = agentPromptLoadCache.get(agentId);
  if (cached && Date.now() - cached.loadedAt < AGENT_PROMPT_CACHE_TTL) {
    return cached.result;
  }

  const agentDir = findAgentDir(agentId);
  if (!agentDir) return null;

  try {
    // Lazy import to avoid circular dependency at module load time
    const { REGISTERED_SECTION_IDS } = await import('../prompts/sections/index');

    const entries = fs.readdirSync(agentDir, { withFileTypes: true });
    const mdFiles = entries
      .filter(e => e.isFile() && e.name.endsWith('.md') && e.name !== 'environment.md')
      .sort((a, b) => {
        const order = (name: string) => name === 'soul.md' ? 0 : 1;
        return order(a.name) - order(b.name) || a.name.localeCompare(b.name);
      });

    // Read config.yaml
    let agentName = agentId;
    let config: AgentConfig | null = null;
    const yamlPath = path.join(agentDir, 'config.yaml');
    if (fs.existsSync(yamlPath)) {
      try {
        const yaml = await import('yaml');
        config = yaml.parse(fs.readFileSync(yamlPath, 'utf-8'));
        if (config?.name) agentName = config.name;
      } catch { /* ignore yaml parse errors */ }
    }

    const sectionOverrides = new Map<string, string>();
    const genericSections: string[] = [];
    let totalChars = 0;

    for (const file of mdFiles) {
      const filePath = path.join(agentDir, file.name);
      let content = fs.readFileSync(filePath, 'utf-8').trim();
      if (!content) continue;

      // Truncate if exceeds per-file limit
      content = truncateBootstrapContent(content);

      // Check total budget
      if (totalChars + content.length > BOOTSTRAP_TOTAL_MAX_CHARS) {
        console.warn(`[BaseNode] Bootstrap total budget exceeded for ${ agentId }, skipping ${ file.name }`);
        break;
      }
      totalChars += content.length;

      // Check if this file name matches a registered section ID
      const sectionId = file.name.replace(/\.md$/, '');
      if (REGISTERED_SECTION_IDS.has(sectionId)) {
        sectionOverrides.set(sectionId, content);
      } else {
        genericSections.push(content);
      }
    }

    // Get template variables and substitute in generic prompt
    const vars = await getTemplateVariables();
    vars['{{agent_name}}'] = agentName;
    vars['{{agent_id}}'] = agentId;
    vars['{{agent_dir}}'] = agentDir;

    const genericPrompt = genericSections.length > 0
      ? applyTemplateVars(genericSections.join('\n\n'), vars)
      : '';

    // Also apply template vars to section overrides
    for (const [id, content] of sectionOverrides) {
      sectionOverrides.set(id, applyTemplateVars(content, vars));
    }

    const excludeSections = Array.isArray(config?.exclude_sections)
      ? config.exclude_sections
      : [];

    const result: AgentPromptLoadResult = {
      agentName,
      genericPrompt,
      sectionOverrides,
      excludeSections,
      config,
    };

    agentPromptLoadCache.set(agentId, { result, loadedAt: Date.now() });
    return result;
  } catch (err) {
    console.error(`[BaseNode] Failed to load agent prompt data for ${ agentId }:`, err);
    return null;
  }
}

/**
 * Load all .md files from an agent's directory and return them as a combined
 * prompt string with template variables substituted.
 *
 * Returns null if the agent directory doesn't exist or has no .md files,
 * in which case the caller should fall back to the global soul prompt.
 */
async function loadAgentPromptFiles(agentId: string): Promise<string | null> {
  if (!agentId) return null;

  // Check cache
  const cached = agentPromptCache.get(agentId);
  if (cached && Date.now() - cached.loadedAt < AGENT_PROMPT_CACHE_TTL) {
    return cached.content;
  }

  const agentDir = findAgentDir(agentId);
  if (!agentDir) return null;

  try {
    const entries = fs.readdirSync(agentDir, { withFileTypes: true });
    const mdFiles = entries
      .filter(e => e.isFile() && e.name.endsWith('.md') && e.name !== 'environment.md')
      .sort((a, b) => {
        // soul.md first, then alphabetical
        const order = (name: string) => name === 'soul.md' ? 0 : 1;
        return order(a.name) - order(b.name) || a.name.localeCompare(b.name);
      });

    if (mdFiles.length === 0) return null;

    // Read config.yaml for agent name (used in the identity prefix)
    let agentName = agentId;
    const yamlPath = path.join(agentDir, 'config.yaml');
    if (fs.existsSync(yamlPath)) {
      try {
        const yaml = await import('yaml');
        const parsed = yaml.parse(fs.readFileSync(yamlPath, 'utf-8'));
        if (parsed?.name) agentName = parsed.name;
      } catch { /* ignore yaml parse errors */ }
    }

    // Read all .md files
    const sections: string[] = [];
    for (const file of mdFiles) {
      const filePath = path.join(agentDir, file.name);
      const content = fs.readFileSync(filePath, 'utf-8').trim();
      if (content) {
        sections.push(content);
      }
    }

    if (sections.length === 0) return null;

    // Get template variables and substitute
    const vars = await getTemplateVariables();
    // Add agent-specific variables
    vars['{{agent_name}}'] = agentName;
    vars['{{agent_id}}'] = agentId;
    vars['{{agent_dir}}'] = agentDir;

    const combined = applyTemplateVars(sections.join('\n\n'), vars);

    // Build the final prompt with an identity prefix
    const primaryUserName = await SullaSettingsModel.get('primaryUserName', '');
    const identityPrefix = primaryUserName.trim()
      ? `You are ${ agentName } (agent: ${ agentId })\nThe Human's name is: ${ primaryUserName }\n\n`
      : `You are ${ agentName } (agent: ${ agentId })\n\n`;

    const result = identityPrefix + combined;

    // Cache it
    agentPromptCache.set(agentId, { content: result, loadedAt: Date.now() });

    return result;
  } catch (err) {
    console.error(`[BaseNode] Failed to load agent prompt files for ${ agentId }:`, err);
    return null;
  }
}


// ============================================================================
// Primary Classes
// ============================================================================

/**
 *
 */
export abstract class BaseNode<T extends BaseThreadState = BaseThreadState> {
  id:                            string;
  name:                          string;
  protected llm:                 BaseLanguageModel | null = null;
  private currentNodeRunContext: NodeRunContext | null = null;
  private _chatController:       ChatController | null = null;
  private _toolExecutor:         ToolExecutor | null = null;

  constructor(id: string, name: string) {
    this.id = id;
    this.name = name;
  }

  /** Lazy-init ToolExecutor. Passes a context that bridges back to this node. */
  protected get toolExecutor(): ToolExecutor {
    if (!this._toolExecutor) {
      this._toolExecutor = new ToolExecutor({
        nodeId:                this.id,
        nodeName:              this.name,
        get currentNodeRunContext() { return null; }, // overridden below
        wsChatMessage:         (state, content, role, kind) => this.wsChatMessage(state, content, role, kind),
        bumpStateVersion:      (state) => this.bumpStateVersion(state),
      });
      // Wire live currentNodeRunContext via property descriptor
      const self = this;
      Object.defineProperty(this._toolExecutor['ctx'], 'currentNodeRunContext', {
        get() { return self.currentNodeRunContext; },
        configurable: true,
      });
    }
    return this._toolExecutor;
  }

  /**
   * Lazy-init ChatController. Created once per BaseNode instance and reused
   * across LLM calls. The controller's mode is set per-call in normalizedChat().
   */
  protected getChatController(): ChatController {
    if (!this._chatController) {
      this._chatController = new ChatController({
        dispatch:        (state, type, data) => this.dispatchToWebSocket(
          state.metadata.wsChannel || 'workbench',
          { type, data },
        ),
        sendChatMessage: (state, content, role, kind) => this.wsChatMessage(state, content, role, kind),
        voiceLog:        (state, component, event, data) => this.voiceLog(state, component, event, data ?? {}),
      });
    }

    return this._chatController;
  }

  abstract execute(state: T): Promise<NodeResult<T>>;

  protected bumpStateVersion(_state: BaseThreadState): void {
    // Version tracking removed: state mutations are applied on live references.
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
    // Resolve the agent ID and config from graph state
    const agentId = String(state.metadata.wsChannel || '').trim();
    const agentMeta = (state.metadata as any).agent as AgentConfig | undefined;

    // Build template variables
    const templateVars = await getTemplateVariables();
    templateVars['{{agent_name}}'] = agentMeta?.name || agentId || templateVars['{{botName}}'];
    templateVars['{{agent_id}}'] = agentId;
    templateVars['{{agent_dir}}'] = findAgentDir(agentId) || path.join(resolveSullaAgentsDir(), agentId);

    // Filter tool categories if agent has a restricted tool list
    if (agentMeta?.tools?.length) {
      const allowSet = new Set(agentMeta.tools);
      const filteredCategories = toolRegistry.getCategoriesWithDescriptions()
        .filter(({ category }: { category: string }) => {
          const toolsInCat = toolRegistry.getToolNamesForCategory(category);
          return category === 'meta' || toolsInCat.some((name: string) => allowSet.has(name));
        });
      templateVars['{{tool_categories}}'] = filteredCategories
        .map(({ category, description }: { category: string; description: string }) => `- ${ category }: ${ description }`)
        .join('\n');
    }

    // Build integrations index
    templateVars['{{integrations_index}}'] = await buildIntegrationsIndex(agentMeta?.integrations);
    const intIndex = templateVars['{{integrations_index}}'];
    if (intIndex.includes('No integrations configured') || intIndex.includes('No matching integrations')) {
      templateVars['{{integrations_instructions}}'] = '';
    } else {
      templateVars['{{integrations_instructions}}'] = INTEGRATIONS_INSTRUCTIONS_BLOCK;
    }

    // Load agent-specific .md files and split into section overrides vs generic prompt
    let agentSectionOverrides = new Map<string, string>();
    let excludeSections = new Set<string>();
    let agentConfig: AgentConfig | null = agentMeta || null;

    if (agentId) {
      const agentData = await loadAgentPromptData(agentId);
      if (agentData) {
        agentSectionOverrides = agentData.sectionOverrides;
        excludeSections = new Set(agentData.excludeSections);
        agentConfig = agentData.config || agentConfig;

        // Set the generic prompt as the agent_prompt content in the config
        if (agentData.genericPrompt) {
          agentConfig = { ...agentConfig, prompt: agentData.genericPrompt };
        }
      }
    }

    // Handle legacy excludeSoul → exclude_sections mapping
    if (agentMeta?.excludeSoul === true) {
      excludeSections.add('soul');
    }

    // Determine trust level
    const trust = (state.metadata as any).isTrustedUser;
    const trustLevel = trust === 'untrusted' ? 'untrusted'
      : trust === 'verify' ? 'verify'
        : 'trusted';

    // Detect provider
    const llm = await getPrimaryService();
    const providerName = llm?.getProviderName?.() || 'anthropic';

    // Determine prompt mode — auto-select 'local' for local LLMs (ollama/llama-server)
    // to use condensed prompts that fit in smaller context windows.
    const mode = options.promptMode || (providerName === 'ollama' ? 'local' : 'full');

    // Build prompt context
    const buildCtx: PromptBuildContext = {
      mode,
      agentId,
      agentConfig,
      provider:             providerName,
      chatMode:             options.chatMode || 'text',
      trustLevel:           trustLevel as 'trusted' | 'verify' | 'untrusted',
      isSubAgent:           !!(state.metadata as any).isSubAgent,
      isHeartbeat:          options.isHeartbeat || false,
      wsChannel:            String(state.metadata.wsChannel || 'sulla-desktop'),
      templateVars,
      agentSectionOverrides,
      excludeSections,
      basePrompt:           basePrompt || '',
    };

    // Build the prompt using the section-based builder
    const built = await SystemPromptBuilder.build(buildCtx);

    // Store Anthropic cache blocks on state metadata for AnthropicService pickup
    if (built.anthropicSystem) {
      (state.metadata as any).__anthropicSystemBlocks = built.anthropicSystem;
    }

    return built.text;
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
    options: LLMCallOptions = {},
  ): Promise<any | null> {
    const reply = await this.normalizedChat(state, systemPrompt, options);
    if (!reply) return null;

    // Execute pending tool calls (preserves default behavior for callers using chat())
    await this.processPendingToolCalls(state, reply);

    if (options.format === 'json') {
      const parsedReply = this.parseJson(reply.content);
      console.log(`[${ this.name }] Parsed JSON in method:chat:`, parsedReply);
      return parsedReply;
    }
    return reply.content;
  }

  /**
   * Check if n8n integration is connected via IntegrationService.
   * Returns false if the service is unavailable or no account is connected.
   */
  protected async isN8nEnabled(): Promise<boolean> {
    try {
      const { getIntegrationService } = await import('../services/IntegrationService');
      return await getIntegrationService().isAnyAccountConnected('n8n');
    } catch {
      return false;
    }
  }

  /**
   * Check if the current agent opts into observation injection.
   * Planning pipeline agents (observer, thinker, etc.) opt out via config.yaml.
   */
  protected async shouldInjectObservationsForAgent(state: BaseThreadState): Promise<boolean> {
    const agentId = String(state.metadata.wsChannel || '').trim();
    if (!agentId) return true;

    try {
      const agentDir = findAgentDir(agentId);
      const configPath = agentDir ? path.join(agentDir, 'config.yaml') : '';
      if (fs.existsSync(configPath)) {
        const yaml = await import('yaml');
        const agentCfg = yaml.parse(fs.readFileSync(configPath, 'utf-8'));
        if (agentCfg?.injectObservations === false) {
          return false;
        }
      }
    } catch { /* ignore config read errors — default to injecting */ }

    return true;
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
    options: LLMCallOptions = {},
  ): Promise<NormalizedResponse | null> {
    this.llm = await getPrimaryService();

    const nodeRunContext = this.createNodeRunContext(state, {
      systemPrompt,
      policy: options.nodeRunPolicy,
    });

    const callToolAccessPolicy = this.buildToolAccessPolicyForCall(options);
    const messages = [...nodeRunContext.messages];

    // Check if the last non-system message is from the assistant.
    // This indicates the agent has already responded and the graph should be done.
    const lastNonSystemMessage = messages.filter(m => m.role !== 'system').pop();
    if (lastNonSystemMessage?.role === 'assistant') {
      console.log(`[${ this.name }] Last message is from assistant — skipping LLM call and marking as done`);
      // Return a done response that signals the graph should complete
      return {
        content:  lastNonSystemMessage.content as string || '',
        metadata: {
          tokens_used:       0,
          time_spent:        0,
          finish_reason:     FinishReason.Stop,
          rawProviderContent: lastNonSystemMessage.content,
        },
      };
    }

    // Pre-flight context check: trim messages to fit the active model's context window
    const contextWindow = this.llm.getContextWindow();
    const responseReserve = Math.floor(contextWindow * 0.20);
    const inputBudgetTokens = contextWindow - responseReserve;
    const estimateTokens = (text: string) => Math.ceil((text?.length ?? 0) / 4);

    let totalTokens = messages.reduce((sum, m) => {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return sum + estimateTokens(content);
    }, 0);

    if (totalTokens > inputBudgetTokens) {
      console.warn(`[${ this.name }] Pre-flight trim: ~${ totalTokens } tokens exceeds ${ inputBudgetTokens } budget (ctx=${ contextWindow })`);
      // Find protected indices: system messages + latest user message
      const systemIndices = new Set<number>();
      let latestUserIdx = -1;
      for (let i = 0; i < messages.length; i++) {
        if (messages[i].role === 'system') systemIndices.add(i);
        if (messages[i].role === 'user') latestUserIdx = i;
      }
      // Build a set of indices that form tool_use/tool_result pairs so we
      // never drop one half of a pair (which would corrupt the message array
      // and cause "tool_call_id not found" API errors).
      const toolPairIndices = new Set<number>();
      for (let idx = 0; idx < messages.length; idx++) {
        const msg = messages[idx];
        const hasToolUse = msg.role === 'assistant' && Array.isArray(msg.content) &&
          msg.content.some((b: any) => b?.type === 'tool_use');
        if (hasToolUse) {
          const next = messages[idx + 1];
          const nextHasToolResult = next?.role === 'user' && Array.isArray(next.content) &&
            next.content.some((b: any) => b?.type === 'tool_result');
          if (nextHasToolResult) {
            toolPairIndices.add(idx);
            toolPairIndices.add(idx + 1);
          }
        }
      }

      // Drop from oldest non-protected until under budget
      let i = 0;
      while (totalTokens > inputBudgetTokens && i < messages.length) {
        if (!systemIndices.has(i) && i !== latestUserIdx && !toolPairIndices.has(i)) {
          const rawContent = messages[i].content;
          totalTokens -= estimateTokens(typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent));
          messages.splice(i, 1);
          // Rebuild protected indices after splice
          if (latestUserIdx > i) latestUserIdx--;
          // Shift toolPairIndices down
          const shifted = new Set<number>();
          for (const idx of toolPairIndices) {
            if (idx > i) shifted.add(idx - 1);
            else if (idx < i) shifted.add(idx);
          }
          toolPairIndices.clear();
          for (const idx of shifted) toolPairIndices.add(idx);
        } else {
          i++;
        }
      }
      console.log(`[${ this.name }] Pre-flight trim complete: ${ messages.length } messages, ~${ totalTokens } tokens`);
    }

    // Check for abort before making LLM calls
    throwIfAborted(state, 'Chat operation aborted');

    // Build LLM tools
    // When allowedToolNames is set, use ONLY the pre-resolved tools — no
    // discovery, no fallbacks, no extra injection. The agent gets exactly
    // the tools it was given and nothing else.
    let llmTools: any[] = [];
    if (!options.disableTools) {
      if (options.allowedToolNames?.length && (state as any).llmTools) {
        // Strict mode: use only pre-resolved tools, already filtered by name
        llmTools = (state as any).llmTools;
      } else {
        // Dynamic discovery mode (primary agent)
        llmTools = (state as any).llmTools;
        if (!llmTools && state.foundTools?.length) {
          const metaLLMTools = await toolRegistry.getLLMToolsFor(await toolRegistry.getToolsByCategory('meta'));
          const foundLLMTools = await Promise.all(state.foundTools.map((tool: any) => toolRegistry.convertToolToLLM(tool.name)));
          llmTools = [...metaLLMTools, ...foundLLMTools];
        }
        if (!llmTools) {
          llmTools = await toolRegistry.getLLMToolsFor(await toolRegistry.getToolsByCategory('meta'));
        }

        const filtered = await this.filterLLMToolsByAccessPolicy(llmTools, options);
        llmTools = filtered.tools;

        // Apply agent tool allowlist from agent config
        const agentToolAllowlist = (state.metadata as any).agent?.tools;
        if (Array.isArray(agentToolAllowlist) && agentToolAllowlist.length > 0) {
          const allowSet = new Set(agentToolAllowlist);
          const metaNames = toolRegistry.getToolNamesForCategory('meta');
          metaNames.forEach(n => allowSet.add(n));
          llmTools = llmTools.filter((t: any) => {
            const name = t?.function?.name;
            return name && allowSet.has(name);
          });
        }

        // Block dangerous/recursive tools for sub-agents (workflow workers)
        if ((state.metadata as any).isSubAgent) {
          const subAgentBlockedTools = new Set([
            'execute_workflow', 'restart_from_checkpoint',
            'spawn_agent', 'check_agent_jobs',
            'rdctl_reset', 'rdctl_shutdown', 'rdctl_set', 'rdctl_start',
            'lima_create', 'lima_delete', 'lima_stop',
            'docker_rm', 'docker_stop',
            'kubectl_delete', 'kubectl_apply',
            'install_extension', 'uninstall_extension',
            'git_push', 'git_stash', 'git_checkout',
          ]);
          llmTools = llmTools.filter((t: any) => !subAgentBlockedTools.has(t?.function?.name));
        }

        // Block sub-agent spawning on local models — slots are limited
        if ((state.metadata as any).llmLocal) {
          const localBlockedTools = new Set(['spawn_agent', 'check_agent_jobs']);
          llmTools = llmTools.filter((t: any) => !localBlockedTools.has(t?.function?.name));
        }

        // Block browser/playwright tools when caller has no visible browser
        if ((state.metadata as any).userVisibleBrowser === false) {
          const browserTools = new Set([
            'browser_tab', 'click_element', 'get_form_values',
            'get_page_snapshot', 'get_page_text', 'scroll_to_element',
            'set_field', 'wait_for_element', 'browse_page', 'synthesize_tabs',
          ]);
          llmTools = llmTools.filter((t: any) => !browserTools.has(t?.function?.name));
        }

        // Block n8n tools when n8n integration is not connected
        if (!await this.isN8nEnabled()) {
          const n8nToolNames = new Set(toolRegistry.getToolNamesForCategory('n8n'));
          llmTools = llmTools.filter((t: any) => !n8nToolNames.has(t?.function?.name));
        }

        // Inject Anthropic-native computer use tools (only in dynamic mode)
        if ((state.metadata as any).userVisibleBrowser !== false) {
        const providerName = (state.metadata as any).providerName
          || (state.metadata as any).provider
          || '';
        const isAnthropic = typeof providerName === 'string' &&
          providerName.toLowerCase().includes('anthropic');

        if (isAnthropic) {
          const nativeDefs = toolRegistry.getNativeToolDefinitions();
          for (const [, def] of nativeDefs) {
            // Avoid duplicates — native tools use raw definitions, not function format
            llmTools.push(def);
          }
        }
      }
      }
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

      // Configure the ChatController mode based on request metadata.
      // The controller's extractors will handle prompt enrichment and response parsing.
      const inputSource = (state.metadata as any).inputSource ?? '';
      const voiceMode = (state.metadata as any).voiceMode ?? '';
      const controller = this.getChatController();
      let chatMode: ChatMode = 'text';
      if (inputSource === 'microphone') {
        chatMode = (voiceMode === 'secretary' || voiceMode === 'intake') ? voiceMode as ChatMode : 'voice';
      } else if (inputSource.startsWith('secretary-') || voiceMode === 'secretary') {
        chatMode = 'secretary';
      }
      controller.setMode(chatMode);

      // Always use streaming when available — voice mode adds progressive TTS dispatch
      let reply: NormalizedResponse | null = await this.callLLMStreaming(state, messages, {
        maxTokens:   options.maxTokens,
        format:      options.format,
        temperature: options.temperature,
        signal:      state.metadata?.options?.abort?.signal,
        tools:       llmTools,
        conversationId,
        nodeName,
      }, nodeRunContext);

      // Detect empty response (no content AND no tool calls) and retry once with reduced context
      if (reply && !reply.content?.trim() && !reply.metadata.tool_calls?.length) {
        console.warn(`[${ this.name }] Empty response from LLM (finish_reason=${ reply.metadata.finish_reason }, model=${ this.llm.getModel() }). Retrying with reduced context.`);
        const systemMsgs = messages.filter(m => m.role === 'system');
        const recentMsgs = messages.filter(m => m.role !== 'system').slice(-3);
        const reducedMessages = [...systemMsgs, ...recentMsgs];

        // Retry uses non-streaming fallback
        reply = await this.llm!.chat(reducedMessages, {
          maxTokens:   options.maxTokens,
          format:      options.format,
          temperature: options.temperature,
          signal:      state.metadata?.options?.abort?.signal,
          tools:       llmTools,
          conversationId,
          nodeName,
        });
      }

      if (!reply || (!reply.content?.trim() && !reply.metadata.tool_calls?.length)) {
        throw new Error(`LLM returned empty response after retry (model=${ this.llm!.getModel() }, provider=${ this.llm!.getProviderName() })`);
      }

      // In text mode, the LLM may spontaneously include <speak> tags — extract and dispatch them.
      // All other processing (thinking, speak during streaming, secretary) is handled by
      // the ChatController's extractors in callLLMStreaming → processComplete().
      if (chatMode === 'text') {
        controller.processNonVoiceSpeak(reply, controller.buildContext(state));
      }

      // Append to state — stores native tool_use content arrays when present
      this.appendResponse(state, reply.content, reply.metadata.rawProviderContent);

      // Send token information to AgentPersona
      this.dispatchTokenInfoToAgentPersona(state, reply);

      // Training data: capture LLM turn (user message + assistant response + reasoning)
      this.logTrainingTurn(state, nodeRunContext, reply);

      return reply;
    } catch (err) {
      if ((err as any)?.name === 'AbortError') throw err;

      console.warn(`[${ this.name }:BaseNode] Primary LLM failed:`, err instanceof Error ? err.message : String(err));

      // Fallback to secondary provider — only if it's healthy
      try {
        const secondary = await getSecondaryService();
        await secondary.initialize();
        if (secondary.isAvailable()) {
          console.log(`[${ this.name }:BaseNode] Falling back to secondary provider (${ secondary.getModel() })`);
          const chatMessages = messages.filter(msg =>
            ['system', 'user', 'assistant'].includes(msg.role),
          );
          const reply = await secondary.chat(chatMessages, {
            signal:      state.metadata?.options?.abort?.signal,
            temperature: options.temperature,
            maxTokens:   options.maxTokens,
            format:      options.format,
            conversationId,
            nodeName,
          });
          if (reply) {
            this.appendResponse(state, reply.content, reply.metadata.rawProviderContent);
            return reply;
          }
        } else {
          console.warn(`[${ this.name }:BaseNode] Secondary provider not available — skipping fallback`);
        }
      } catch (fallbackErr) {
        if ((fallbackErr as any)?.name === 'AbortError') throw fallbackErr;
        console.error(`[${ this.name }:BaseNode] Secondary provider fallback failed:`, fallbackErr);
      }

      // Propagate the error so the chat UI can display it to the user
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`[${ this.name }] LLM provider failed: ${ message }`);
    } finally {
      this.currentNodeRunContext = previousRunContext;
      (state.metadata as any).__toolAccessPolicy = previousToolAccessPolicy;
    }
  }

  private buildToolAccessPolicyForCall(options: LLMCallOptions) {
    return this.toolExecutor.buildToolAccessPolicyForCall(options);
  }

  private async filterLLMToolsByAccessPolicy(
    llmTools: any[],
    options: LLMCallOptions,
  ): Promise<{ tools: any[] }> {
    if (!Array.isArray(llmTools) || llmTools.length === 0) {
      return { tools: llmTools || [] };
    }
    return this.toolExecutor.filterLLMToolsByAccessPolicy(llmTools, options);
  }

  protected getDefaultNodeRunPolicy(): Required<NodeRunPolicy> {
    return {
      messageSource:           'graph',
      persistAssistantToGraph: true,
    };
  }

  protected createNodeRunContext(
    state: BaseThreadState,
    input: {
      systemPrompt: string;
      policy?:      NodeRunPolicy;
    },
  ): NodeRunContext {
    const defaults = this.getDefaultNodeRunPolicy();
    const policy: Required<NodeRunPolicy> = {
      ...defaults,
      ...(input.policy || {}),
    };

    const systemMessage: ChatMessage = {
      role:    'system',
      content: (input.systemPrompt ?? '').trim(),
      metadata: (state.metadata as any).__anthropicSystemBlocks
        ? { __anthropicSystemBlocks: (state.metadata as any).__anthropicSystemBlocks }
        : undefined,
    };

    const mergedMessages: ChatMessage[] = [
      ...(state.messages || []).filter(msg => msg.role !== 'system').map(msg => ({ ...msg })),
      systemMessage,
    ];

    return {
      runId:           `${ this.id }_${ Date.now() }_${ Math.random().toString(36).slice(2, 8) }`,
      nodeId:          this.id,
      nodeName:        this.name,
      messages:        mergedMessages,
      toolTranscript:  [],
      hadToolCalls:    false,
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
    const normalizedContent = stripProtocolTags(contentStr);

    // Determine if the raw provider content has tool_use blocks
    const hasToolUseBlocks = Array.isArray(rawProviderContent) &&
            rawProviderContent.some((b: any) => b?.type === 'tool_use');

    // If pure tool_use response with no text, still store the native content
    if (!normalizedContent && !hasToolUseBlocks) {
      return;
    }

    // Use native content array when tool_use blocks are present.
    // Strip protocol tags from text blocks inside native content arrays too.
    let messageContent: any;
    if (hasToolUseBlocks) {
      messageContent = rawProviderContent.map((block: any) => {
        if (block?.type === 'text' && typeof block.text === 'string') {
          return { ...block, text: stripProtocolTags(block.text) };
        }
        return block;
      });
    } else {
      messageContent = normalizedContent;
    }

    const messageMeta: Record<string, any> = {
      nodeId:    this.id,
      timestamp: Date.now(),
    };

    if (this.currentNodeRunContext) {
      this.currentNodeRunContext.messages.push({
        role:     'assistant',
        content:  normalizedContent || '',
        metadata: messageMeta,
      });
    }

    // Deduplicate — skip if a recent assistant message is identical or near-identical
    if (typeof messageContent === 'string' && messageContent.trim().length > 0) {
      const DEDUP_WINDOW = 3;
      const SIMILARITY_THRESHOLD = 0.85;
      for (let i = state.messages.length - 1; i >= 0 && i >= state.messages.length - DEDUP_WINDOW; i--) {
        const prev = state.messages[i];
        if (prev.role === 'assistant' && typeof prev.content === 'string') {
          if (prev.content.trim() === messageContent.trim() ||
              BaseNode.jaccardSimilarity(prev.content, messageContent) > SIMILARITY_THRESHOLD) {
            return;
          }
        }
      }
    }

    state.messages.push({
      role:     'assistant',
      content:  messageContent,
      metadata: messageMeta,
    });
    this.bumpStateVersion(state);
  }

  // ─────────────────────────────────────────────────────────────
  // Streaming LLM call with progressive <speak> dispatch (voice mode)
  // ─────────────────────────────────────────────────────────────


  /**
   * Stream LLM tokens through the ChatController's extractor pipeline.
   * Extractors handle speak extraction (voice mode), thinking extraction,
   * and streaming dispatch (text mode). See ChatController + Extractors.
   */
  private async callLLMStreaming(
    state: BaseThreadState,
    messages: ChatMessage[],
    options: any,
    nodeRunContext: any,
  ): Promise<NormalizedResponse | null> {
    const controller = this.getChatController();
    const ctx = controller.buildContext(state);

    this.voiceLog(state, 'LLM', 'STREAM_START', { mode: controller.getMode(), model: this.llm?.getModel() });

    // Reset extractor state for this new LLM call
    controller.reset();

    // Text streaming state — throttle at ~50ms to avoid flooding the WebSocket
    let contentBuffer = '';
    let lastStreamFlush = 0;
    const STREAM_THROTTLE_MS = 50;
    const isVoiceMode = controller.getMode() === 'voice';

    const onToken = (token: string): void => {
      contentBuffer += token;

      // Run token through all active extractors (speak extraction, etc.)
      const cleaned = controller.processChunk(token, ctx);

      // Non-voice mode: stream accumulated text to the UI progressively
      if (!isVoiceMode && cleaned) {
        const now = Date.now();
        if (now - lastStreamFlush >= STREAM_THROTTLE_MS) {
          lastStreamFlush = now;
          const stripped = stripProtocolTags(contentBuffer);
          if (stripped.trim()) {
            this.wsChatMessage(state, stripped, 'assistant', 'streaming');
          }
        }
      }
    };

    const reply = await this.llm!.chatStream(messages, { onToken }, options);

    if (!reply) {
      return null;
    }

    // Run post-completion processing through all active extractors
    // (thinking extraction, speak tag cleanup, secretary analysis, etc.)
    controller.processComplete(reply, ctx);

    return reply;
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
    onMessage?: WebSocketMessageHandler,
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
        tokens_used:       reply.metadata.tokens_used,
        prompt_tokens:     reply.metadata.prompt_tokens,
        completion_tokens: reply.metadata.completion_tokens,
        time_spent:        reply.metadata.time_spent,
        threadId:          state.metadata.threadId,
        nodeId:            this.name,
      },
      timestamp: Date.now(),
    });

    if (!sent) {
      console.warn(`[BaseNode:${ this.name }] Failed to send token info via WebSocket`);
    }
  }

  /**
     * Sends a chat message to the frontend via WebSocket as an
     * 'assistant_message' event. Used for progress updates, streaming tokens,
     * thinking content, and error messages.
     *
     * NEVER used for speak/TTS content — if `kind='speak'` leaks here, it is
     * redirected to `wsSpeakDispatch()` as a safety net (with a warning log).
     *
     * @param state   BaseThreadState containing the connection ID in metadata
     * @param content Message content to display
     * @param role    'assistant' | 'system' - defaults to 'assistant'
     * @param kind    Optional UI kind tag - defaults to 'progress'
     * @returns true if message was sent via WebSocket
     */
  protected async wsChatMessage(
    state: BaseThreadState,
    content: string,
    role: 'assistant' | 'system' = 'assistant',
    kind = 'progress',
  ): Promise<boolean> {
    // Defence-in-depth: strip agent protocol XML before any user-visible output
    content = stripProtocolTags(content);
    if (!content) {
      return false;
    }

    const threadId = state.metadata.threadId;

    // If the graph muted chat output (e.g. during internal planning like
    // SPAWN_COUNT negotiation), skip the WebSocket send entirely.  The
    // conversation logger still records the message for debugging.
    const muted = !!(state.metadata as any)._muteWsChat;

    // Log to conversation logger so the Live Monitor can see all messages.
    const convId = (state.metadata as any).conversationId;
    if (convId && kind !== 'thinking' && kind !== 'streaming') {
      try {
        const { getConversationLogger } = require('../services/ConversationLogger');
        getConversationLogger().logMessage(convId, role, content.trim());
      } catch { /* best-effort */ }
    }

    if (muted) {
      return true; // swallow the message — it's internal orchestrator chatter
    }

    // Get connection ID from state or use default
    const connectionId = (state.metadata.wsChannel) || DEFAULT_WS_CHANNEL;

    // Ensure WebSocket connection exists
    if (!this.isWebSocketConnected(connectionId)) {
      console.log(`[${ this.name }:BaseNode] Not Connected`);
      this.connectWebSocket(connectionId);
    }

    // Speak messages must use wsSpeakDispatch — not wsChatMessage.
    // If speak kind leaks here, redirect to the dedicated speak dispatch.
    if (kind === 'speak') {
      console.warn(`[BaseNode:wsChatMessage] speak kind redirected to wsSpeakDispatch`);
      this.voiceLog(state, 'WS', 'SPEAK_REDIRECT', { text: content.slice(0, 200) });
      return this.wsSpeakDispatch(state, content);
    }

    // Send via WebSocket
    const sent = await this.dispatchToWebSocket(connectionId, {
      type: 'assistant_message',
      data: {
        content:   content.trim(),
        role,
        kind,
        thread_id: threadId,
        timestamp: Date.now(),
      },
    });

    if (!sent) {
      console.warn(`[Agent:${ this.name }] Failed to send chat message via WebSocket (kind=${kind})`);
    } else {
      state.metadata.hadUserMessages = true;
    }

    // If this agent is running inside a workflow, also emit a node_thinking
    // event so the workflow canvas can display the conversation in a bubble.
    const workflowNodeId = (state.metadata as any).workflowNodeId;
    const workflowParentChannel = (state.metadata as any).workflowParentChannel;
    if (workflowNodeId && workflowParentChannel) {
      console.log(`[BaseNode:wsChatMessage] Emitting node_thinking → channel="${ workflowParentChannel }", nodeId="${ workflowNodeId }", content="${ content.trim().slice(0, 80) }"`);
      try {
        const ws = getWebSocketClientService();
        ws.send(workflowParentChannel, {
          type: 'workflow_execution_event',
          data: {
            type:      'node_thinking',
            nodeId:    workflowNodeId,
            content:   content.trim(),
            role,
            kind,
            thread_id: threadId,
            timestamp: new Date().toISOString(),
          },
          timestamp: Date.now(),
        });
      } catch (e) { console.warn(`[BaseNode:wsChatMessage] node_thinking emit failed:`, e); }
    } else if ((state.metadata as any).isSubAgent && !(state.metadata as any).parentWsChannel) {
      console.warn(`[BaseNode:wsChatMessage] Sub-agent "${ this.name }" missing workflow metadata — workflowNodeId=${ workflowNodeId }, workflowParentChannel=${ workflowParentChannel }`);
    }

    return sent;
  }

  /**
   * Dispatches speak text for TTS playback via a dedicated 'speak_dispatch'
   * WebSocket event. This creates a message with kind='speak' in
   * AgentPersonaModel, which VoicePipeline detects and enqueues for
   * TTSPlayerService.
   *
   * IMPORTANT: This is the ONLY server-side path that should create TTS
   * content. All speak content must flow through here — never through
   * `wsChatMessage()`.
   */

  /**
   * Log a voice pipeline event to ConversationLogger with a grep-friendly tag.
   * Uses the same VOICE:<COMPONENT>:<EVENT> format as the frontend VoiceLogger.
   * Search: grep "VOICE:LLM" or "VOICE:WS" in log files.
   */
  private voiceLog(state: BaseThreadState, component: string, event: string, data: Record<string, unknown> = {}): void {
    const convId = (state.metadata as any).conversationId;
    if (!convId) return;
    try {
      const { getConversationLogger } = require('../services/ConversationLogger');
      getConversationLogger().log(convId, {
        ts: new Date().toISOString(),
        type: `VOICE:${component}:${event}`,
        ...data,
      });
    } catch { /* best-effort */ }
  }

  protected async wsSpeakDispatch(state: BaseThreadState, text: string): Promise<boolean> {
    const clean = text?.trim();
    if (!clean) return false;

    const connectionId = (state.metadata.wsChannel) || DEFAULT_WS_CHANNEL;
    const threadId = state.metadata.threadId;

    if (!this.isWebSocketConnected(connectionId)) {
      this.connectWebSocket(connectionId);
    }

    // Trace: log a stack snippet so we can identify which code path dispatched this
    const callerStack = new Error().stack?.split('\n').slice(1, 4).map(l => l.trim()).join(' < ') || '';
    console.log(`[BaseNode:wsSpeakDispatch] → text="${clean.slice(0, 80)}" | caller: ${callerStack}`);

    this.voiceLog(state, 'WS', 'SPEAK_DISPATCH', { text: clean.slice(0, 200), caller: callerStack });

    // Include pipelineSequence for turn correlation (voice barge-in filtering)
    const pipelineSequence = (state.metadata as any).pipelineSequence ?? null;

    const sent = await this.dispatchToWebSocket(connectionId, {
      type: 'speak_dispatch',
      data: {
        text:      clean,
        thread_id: threadId,
        timestamp: Date.now(),
        pipelineSequence,
      },
    });

    if (!sent) {
      console.warn(`[BaseNode:wsSpeakDispatch] Failed to send speak dispatch`);
    }

    return sent;
  }

  protected async emitToolCallEvent(
    state: BaseThreadState,
    toolRunId: string,
    toolName: string,
    args: Record<string, any>,
    kind?: string,
  ): Promise<boolean> {
    return this.toolExecutor.emitToolCallEvent(state, toolRunId, toolName, args, kind);
  }

  protected async emitToolResultEvent(
    state: BaseThreadState,
    toolRunId: string,
    success: boolean,
    error?: string,
    result?: any,
  ): Promise<boolean> {
    return this.toolExecutor.emitToolResultEvent(state, toolRunId, success, error, result);
  }

  protected async processPendingToolCalls(
    state: BaseThreadState,
    reply: { metadata: { tool_calls?: { name: string; id?: string; args: any }[] } },
  ): Promise<void> {
    return this.toolExecutor.processPendingToolCalls(state, reply);
  }

  // stableStringify, buildToolRunDedupeKey, persistStructuredToolRunRecord → ToolExecutor

  protected async executeToolCalls(
    state: BaseThreadState,
    toolCalls: { name: string; id?: string; args: any }[],
    allowedTools?: string[],
  ): Promise<{ toolName: string; success: boolean; result?: unknown; error?: string }[]> {
    return this.toolExecutor.executeToolCalls(state, toolCalls, allowedTools);
  }

  /**
   * Jaccard similarity between two strings (word-level).
   * Returns 0-1 where 1 means identical word sets.
   */
  protected static jaccardSimilarity(a: string, b: string): number {
    const tokenize = (s: string) => new Set(s.toLowerCase().split(/\s+/).filter(Boolean));
    const setA = tokenize(a);
    const setB = tokenize(b);
    let intersection = 0;
    for (const token of setA) {
      if (setB.has(token)) intersection++;
    }
    const union = setA.size + setB.size - intersection;
    return union === 0 ? 1 : intersection / union;
  }

  public async appendToolResultMessage(
    state: BaseThreadState,
    action: string,
    result: ToolResult,
  ): Promise<void> {
    return this.toolExecutor.appendToolResultMessage(state, action, result);
  }

  private logTrainingTurn(
    state: BaseThreadState,
    runCtx: NodeRunContext,
    reply: NormalizedResponse,
  ): void {
    this.toolExecutor.logTrainingTurn(state, runCtx, reply);
  }
}

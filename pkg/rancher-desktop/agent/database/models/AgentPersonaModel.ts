// AgentPersonaService.ts
import { computed, reactive, ref } from 'vue';
import { getWebSocketClientService, type WebSocketMessage } from '@pkg/agent/services/WebSocketClientService';
import { AgentPersonaRegistry } from '../registry/AgentPersonaRegistry';
import type { ChatMessage, AgentRegistryEntry } from '../registry/AgentPersonaRegistry';
import { formatToolCard, formatToolResult } from '@pkg/agent/tools/toolCardFormatters';

export type PersonaTemplateId =
  | 'terminal'
  | 'industrial'
  | 'biosynthetic'
  | 'glass-core';

export type PersonaStatus = 'online' | 'idle' | 'busy' | 'offline';

export type PersonaEmotion =
  | 'focus'
  | 'industrious'
  | 'curiosity'
  | 'calm'
  | 'mystery'
  | 'joy'
  | 'confidence'
  | 'love'
  | 'anger'
  | 'fear'
  | 'sadness'
  | 'mischief';

export interface AgentPersonaState {
  agentId:   string;
  agentName: string;

  templateId: PersonaTemplateId;
  emotion:    PersonaEmotion;

  status: PersonaStatus;

  tokensPerSecond: number;
  temperature:     number;
  threadId?:       string;

  // Token tracking properties
  totalTokensUsed:       number;
  totalPromptTokens:     number;
  totalCompletionTokens: number;
  lastResponseTime:      number;
  averageResponseTime:   number;
  responseCount:         number;

  // Cost tracking properties (XAI Grok pricing)
  totalInputCost:  number;
  totalOutputCost: number;
  totalCost:       number;
}

export type PersonaAssetType = 'iframe' | 'document';

export interface PersonaSidebarAsset {
  id:         string;
  type:       PersonaAssetType;
  title:      string;
  active:     boolean;
  skillSlug?: string;
  collapsed:  boolean;
  updatedAt:  number;
  url?:       string;
  content?:   string;
  refKey?:    string;
}

// ─── Tool-name → human-friendly verb mapping ───────────────────────────────
const TOOL_VERB_MAP: Record<string, string> = {
  // Execution
  exec: 'Running', exec_command: 'Running', shell: 'Running', bash: 'Running', run_command: 'Running',
  // Search
  file_search: 'Searching', browse_tools: 'Searching tools',
  // Git / GitHub
  git_status: 'Checking status', git_log: 'Reviewing history', git_diff: 'Comparing changes',
  git_add: 'Staging', git_commit: 'Committing', git_push: 'Pushing', git_pull: 'Pulling',
  git_branch: 'Branching', git_checkout: 'Switching branch', git_stash: 'Stashing',
  git_blame: 'Blaming', git_conflicts: 'Resolving conflicts',
  github_create_pr: 'Creating PR', github_create_issue: 'Creating issue',
  github_get_issue: 'Fetching issue', github_get_issues: 'Fetching issues',
  github_read_file: 'Reading', github_create_file: 'Creating', github_update_file: 'Updating',
  github_comment_on_issue: 'Commenting',
  // Docker
  docker_build: 'Building image', docker_run: 'Running container', docker_exec: 'Executing',
  docker_ps: 'Listing containers', docker_logs: 'Reading logs',
  docker_pull: 'Pulling image', docker_stop: 'Stopping container', docker_rm: 'Removing container',
  docker_images: 'Listing images',
  // Kubernetes
  kubectl_apply: 'Applying manifest', kubectl_delete: 'Deleting resource', kubectl_describe: 'Describing resource',
  // Database
  pg_query: 'Querying', pg_queryall: 'Querying', pg_queryone: 'Querying',
  pg_execute: 'Executing SQL', pg_count: 'Counting', pg_transaction: 'Running transaction',
  // Redis
  redis_get: 'Reading cache', redis_set: 'Writing cache', redis_del: 'Clearing cache',
  // N8n / Workflows
  execute_workflow: 'Running workflow', validate_workflow: 'Validating workflow',
  patch_workflow: 'Patching workflow', diagnose_webhook: 'Diagnosing webhook',
  restart_n8n_container: 'Restarting n8n',
  // Playwright / Browser
  click_element: 'Clicking', get_page_snapshot: 'Capturing page', get_page_text: 'Reading page',
  set_field: 'Filling form', scroll_to_element: 'Scrolling',
  // Slack
  slack_send_message: 'Messaging', slack_search_users: 'Searching users',
  // Calendar
  calendar_list: 'Checking calendar', calendar_create: 'Creating event', calendar_list_upcoming: 'Checking schedule',
  // Memory
  add_observational_memory: 'Remembering', remove_observational_memory: 'Forgetting',
  // Skills / Projects
  load_skill: 'Loading skill', create_skill: 'Creating skill',
  // Lima
  lima_shell: 'Running shell', lima_start: 'Starting VM', lima_stop: 'Stopping VM',
  // Channel
  send_channel_message: 'Messaging',
};

function toolNameToVerb(toolName: string): string {
  if (TOOL_VERB_MAP[toolName]) return TOOL_VERB_MAP[toolName];

  // Prefix-based fallbacks
  if (toolName.startsWith('fs_'))      return 'Working with files';
  if (toolName.startsWith('git'))      return 'Using git';
  if (toolName.startsWith('docker_'))  return 'Using Docker';
  if (toolName.startsWith('kubectl_')) return 'Using kubectl';
  if (toolName.startsWith('pg_'))      return 'Querying database';
  if (toolName.startsWith('redis_'))   return 'Using cache';
  if (toolName.startsWith('slack_'))   return 'Using Slack';
  if (toolName.startsWith('n8n_') || toolName.includes('workflow')) return 'Working on workflow';

  return 'Working';
}

export class AgentPersonaService {
  private readonly registry:            AgentPersonaRegistry;
  private wsService = getWebSocketClientService();
  private readonly wsUnsub = new Map<string, () => void>();

  readonly messages:     ChatMessage[] = reactive([]);
  private readonly toolRunIdToMessageId = new Map<string, string>();
  readonly activeAssets: PersonaSidebarAsset[] = reactive([]);

  graphRunning = ref(false);
  waitingForUser = ref(false);
  stopReason = ref<string | null>(null);

  /** Human-friendly verb describing what the agent is currently doing */
  currentActivity = ref('Thinking');

  readonly state = reactive<AgentPersonaState>({
    agentId:   'unit-01',
    agentName: 'UNIT_01',

    templateId: 'glass-core',
    emotion:    'calm',

    status: 'online',

    tokensPerSecond: 847,
    temperature:     0.7,

    // Token tracking initialization
    totalTokensUsed:       0,
    totalPromptTokens:     0,
    totalCompletionTokens: 0,
    lastResponseTime:      0,
    averageResponseTime:   0,
    responseCount:         0,

    // Cost tracking initialization (XAI Grok pricing)
    totalInputCost:  0,
    totalOutputCost: 0,
    totalCost:       0,
  });

  readonly emotionClass = computed(() => `persona-profile-${ this.state.emotion }`);

  /** Optional tab identifier — scopes localStorage keys so multiple tabs are independent */
  private readonly tabId?: string;

  constructor(registry: AgentPersonaRegistry, agentData?: AgentRegistryEntry, requestedAgentId?: string, tabId?: string) {
    this.registry = registry;
    this.tabId = tabId;

    if (agentData) {
      Object.assign(this.state, {
        agentId:         agentData.agentId,
        agentName:       agentData.agentName,
        templateId:      agentData.templateId,
        emotion:         agentData.emotion,
        status:          agentData.status,
        tokensPerSecond: agentData.tokensPerSecond ?? 847,
        temperature:     agentData.temperature ?? 0.7,
        totalTokensUsed: agentData.totalTokensUsed ?? 0,
      });
    } else if (requestedAgentId) {
      // No registry entry exists — use the requested ID so we connect on the right channel
      this.state.agentId = requestedAgentId;
      this.state.agentName = requestedAgentId;
    }

    // Connect immediately — this is the core fix
    this.connectAndListen();
  }

  registerIframeAsset(input: {
    id:         string;
    title:      string;
    url:        string;
    active?:    boolean;
    skillSlug?: string;
    collapsed?: boolean;
    refKey?:    string;
  }): void {
    const url = String(input.url || '').trim();

    if (!url) {
      console.error('[AgentPersonaModel] registerIframeAsset called with empty url', input);
      return;
    }

    console.log('[AgentPersonaModel] registerIframeAsset', {
      id:       input.id,
      url,
      skillSlug: input.skillSlug || '',
    });

    this.upsertAsset({
      id:        input.id,
      type:      'iframe',
      title:     input.title,
      active:    input.active ?? true,
      skillSlug: input.skillSlug,
      collapsed: input.collapsed ?? true,
      updatedAt: Date.now(),
      url,
      refKey:    input.refKey,
    });
  }

  private applyAssetLifecycleUpdate(data: any, phase: string): boolean {
    const asset = (data?.asset && typeof data.asset === 'object') ? data.asset : null;
    if (!asset) {
      return false;
    }

    if (asset?.type === 'iframe') {
      const rawSlug = asset.skillSlug ?? asset.selected_skill_slug ?? data?.selected_skill_slug;
      const skillSlug = typeof rawSlug === 'string' ? rawSlug.trim().toLowerCase() : '';
      const requestedId = String(asset.id || `iframe_${ Date.now() }`);
      const requestedUrl = String(asset.url || '');

      console.log('[AgentPersonaModel] websocket asset lifecycle iframe', {
        phase,
        requestedId,
        requestedUrl,
        skillSlug,
        active:    asset.active !== false,
        collapsed: asset.collapsed !== false,
      });

      this.registerIframeAsset({
        id:        requestedId,
        title:     String(asset.title || 'Website'),
        url:       requestedUrl,
        active:    asset.active !== false,
        skillSlug: skillSlug || undefined,
        collapsed: asset.collapsed !== false,
        refKey:    typeof asset.refKey === 'string' ? asset.refKey : undefined,
      });

      return true;
    }

    if (asset?.type === 'document') {
      const documentId = String(asset.id || `doc_${ Date.now() }`);
      const content = String(asset.content || '');
      const existingDocument = this.activeAssets.find((item) => item.id === documentId && item.type === 'document');

      if (existingDocument) {
        this.updateDocumentAssetContent(documentId, content);
      } else {
        this.registerDocumentAsset({
          id:        documentId,
          title:     String(asset.title || 'Document'),
          content,
          active:    asset.active !== false,
          collapsed: asset.collapsed !== false,
          refKey:    typeof asset.refKey === 'string' ? asset.refKey : undefined,
        });
      }

      return true;
    }

    return false;
  }

  registerDocumentAsset(input: {
    id:         string;
    title:      string;
    content:    string;
    active?:    boolean;
    collapsed?: boolean;
    refKey?:    string;
  }): void {
    this.upsertAsset({
      id:        input.id,
      type:      'document',
      title:     input.title,
      active:    input.active ?? input.content.trim().length > 0,
      collapsed: input.collapsed ?? true,
      updatedAt: Date.now(),
      content:   input.content,
      refKey:    input.refKey,
    });
  }

  updateDocumentAssetContent(assetId: string, content: string): void {
    const asset = this.activeAssets.find((item) => item.id === assetId && item.type === 'document');
    if (!asset) {
      return;
    }
    asset.content = content;
    asset.active = content.trim().length > 0;
    asset.updatedAt = Date.now();
  }

  setAssetCollapsed(assetId: string, collapsed: boolean): void {
    const asset = this.activeAssets.find((item) => item.id === assetId);
    if (!asset) {
      return;
    }

    if (!collapsed) {
      this.activeAssets.forEach((item) => {
        item.collapsed = item.id !== assetId;
      });
    } else {
      asset.collapsed = true;
    }
    asset.updatedAt = Date.now();
  }

  removeAsset(assetId: string): void {
    const index = this.activeAssets.findIndex((item) => item.id === assetId);
    if (index >= 0) {
      this.activeAssets.splice(index, 1);
    }
  }

  private upsertAsset(asset: PersonaSidebarAsset): void {
    const existing = this.activeAssets.find((item) => item.id === asset.id);
    if (existing) {
      Object.assign(existing, asset, { updatedAt: Date.now() });
      return;
    }
    this.activeAssets.push(asset);
  }

  private connectAndListen() {
    const id = this.state.agentId;
    if (this.wsUnsub.has(id)) return;

    console.log(`[AgentPersona:${ this.state.agentName }] Subscribing to WebSocket channel ${ id }`);

    // connect() is now gated behind the hub readiness probe — no need
    // for manual retry logic here; WebSocketConnection handles reconnects.
    this.wsService.connect(id);

    const unsub = this.wsService.onMessage(id, (msg: WebSocketMessage) => {
      this.handleWebSocketMessage(id, msg);
    });

    if (unsub) {
      this.wsUnsub.set(id, unsub);
      console.log(`[AgentPersona:${ this.state.agentName }] Message handler attached for ${ id }`);
    } else {
      console.error(`[AgentPersona:${ this.state.agentName }] Failed to attach message handler for ${ id }`);
    }
  }

  // Kept old signature for compatibility, but agentId is now ignored (service owns its channel)
  async addUserMessage(_agentId: string, content: string, metadata?: Record<string, unknown>): Promise<boolean> {
    return this._addUserMessage(content, metadata);
  }

  // Internal clean version
  private async _addUserMessage(content: string, extraMetadata?: Record<string, unknown>): Promise<boolean> {
    if (!content.trim()) return false;

    const id = this.state.agentId;
    console.log(`[AgentPersonaService] _addUserMessage() — channel="${ id }", threadId="${ this.state.threadId || '(none)' }", content="${ content.slice(0, 80) }"`);
    this.stopReason.value = null;
    this.waitingForUser.value = false;
    this.currentActivity.value = 'Thinking';

    this.messages.push({
      id:        `user_${ Date.now() }_${ Math.random().toString(36).slice(2, 8) }`,
      channelId: id,
      threadId:  this.state.threadId,
      role:      'user',
      content,
    });

    this.registry.setLoading(id, true);

    let delivered: boolean;
    try {
      console.log(`[AgentPersonaService] _addUserMessage() — sending via WebSocket to channel="${ id }"...`);
      delivered = await this.wsService.send(id, {
        type:      'user_message',
        data:      { role: 'user', content, threadId: this.state.threadId, metadata: extraMetadata },
        timestamp: Date.now(),
      });
      console.log(`[AgentPersonaService] _addUserMessage() — WebSocket send result: delivered=${ delivered }`);
    } catch (err) {
      console.error(`[AgentPersonaService] _addUserMessage() — WebSocket send THREW:`, err);
      delivered = false;
    }

    if (!delivered) {
      console.warn(`[AgentPersonaService] Message delivery FAILED for channel="${ id }" — connection may be down`);
      this.registry.setLoading(id, false);
      this.graphRunning.value = false;
      this.messages.push({
        id:        `sys_${ Date.now() }_delivery_fail`,
        channelId: id,
        threadId:  this.state.threadId,
        role:      'system',
        content:   'Message could not be delivered — the connection to the agent appears to be down. Please try again.',
      });
    }

    return delivered;
  }

  private threadStorageKey(): string {
    const base = this.state.agentId;
    return this.tabId ? `chat_threadId_${ base }_${ this.tabId }` : `chat_threadId_${ base }`;
  }

  setThreadId(threadId: string): void {
    this.state.threadId = threadId;
    try {
      localStorage.setItem(this.threadStorageKey(), threadId);
    } catch { /* storage full or unavailable */ }
  }

  getThreadId(): string | undefined {
    return this.state.threadId;
  }

  restoreThreadId(): string | undefined {
    try {
      const saved = localStorage.getItem(this.threadStorageKey());
      if (saved) {
        this.state.threadId = saved;
        return saved;
      }
    } catch { /* unavailable */ }
    return undefined;
  }

  clearThreadId(): void {
    this.state.threadId = undefined;
    this.waitingForUser.value = false;
    try {
      localStorage.removeItem(this.threadStorageKey());
    } catch { /* unavailable */ }
  }

  clearMessages(): void {
    this.messages.splice(0, this.messages.length);
    this.toolRunIdToMessageId.clear();
  }

  async emitContinueRun(): Promise<boolean> {
    const id = this.state.agentId;
    this.stopReason.value = null;
    this.waitingForUser.value = false;
    this.graphRunning.value = true;
    this.registry.setLoading(id, true);

    let delivered: boolean;
    try {
      delivered = await this.wsService.send(id, {
        type:      'continue_run',
        timestamp: Date.now(),
      });
    } catch {
      delivered = false;
    }

    if (!delivered) {
      console.warn(`[AgentPersonaService] continue_run delivery failed for ${ id }`);
      this.registry.setLoading(id, false);
      this.graphRunning.value = false;
      this.messages.push({
        id:        `sys_${ Date.now() }_delivery_fail`,
        channelId: id,
        role:      'system',
        content:   'Could not resume the agent — the connection appears to be down. Please try again.',
      });
    }

    return delivered;
  }

  async emitStopSignal(agentId: string): Promise<boolean> {
    console.log('[AgentPersonaModel] Emitting stop signal for agent:', agentId);
    let sent: boolean;
    try {
      sent = await this.wsService.send(agentId, {
        type:      'stop_run',
        timestamp: Date.now(),
      });
    } catch {
      sent = false;
    }
    console.log('[AgentPersonaModel] Stop signal sent successfully:', sent);
    if (!sent) {
      console.warn(`[AgentPersonaService] Failed to send stop signal on ${ agentId }`);
    }

    return sent;
  }

  /** Idempotent — safe to call on every mount. No-ops if already listening. */
  startListening(): void {
    this.connectAndListen();
  }

  stopListening(agentIds?: string[]): void {
    // Unsubscribe message handlers but do NOT disconnect the shared WebSocket —
    // other services (FrontendGraphWebSocketService, etc.) share the same connection.
    const ids = agentIds?.length ? agentIds : [...this.wsUnsub.keys()];
    for (const agentId of ids) {
      const unsub = this.wsUnsub.get(agentId);
      if (unsub) {
        try {
          unsub();
        } catch {
          // ignore
        }
        this.wsUnsub.delete(agentId);
      }
    }
    this.waitingForUser.value = false;
  }

  /**
   * Extract thread_id from an incoming WebSocket message payload.
   * Backend messages use `thread_id` (snake_case) while some frontend-origin
   * messages use `threadId` (camelCase). We normalise both here.
   */
  private extractThreadId(msg: WebSocketMessage): string | undefined {
    if (msg.data && typeof msg.data === 'object') {
      const d = msg.data as any;
      return typeof d.thread_id === 'string' ? d.thread_id
        : typeof d.threadId === 'string' ? d.threadId
          : undefined;
    }
    return undefined;
  }

  /**
   * Route an incoming WebSocket message to the appropriate handler.
   *
   * This is the **chat-path** entry point for all WebSocket messages on this
   * persona's channel. For `workflow_execution_event` messages specifically,
   * this is one of TWO independent consumers (the other being the canvas path
   * via `EditorChatInterface` → `AgentEditor.vue` → `WorkflowEditor.vue`).
   *
   * **Workflow events handled here** (creates/mutates `ChatMessage` objects
   * with `kind: 'workflow_node'`, rendered by `WorkflowNodeCard.vue`):
   * - `workflow_started` — creates a "Workflow Started" card (status: running)
   * - `node_started` — creates a running node card with nodeId + nodeLabel
   * - `node_completed` / `node_failed` / `node_waiting` — updates existing card
   * - `workflow_completed` / `workflow_failed` — updates the start card's status
   *
   * **Workflow events NOT handled here** (canvas-only):
   * - `edge_activated`, `node_thinking`
   *
   * The event payload originates from `Graph.emitPlaybookEvent()` in the main
   * process. Any changes to the payload shape must be reflected here AND in the
   * canvas-path dispatcher in `AgentEditor.vue`.
   *
   * @param agentId The channel / agent ID this message arrived on
   * @param msg     The raw WebSocket message
   */
  private handleWebSocketMessage(agentId: string, msg: WebSocketMessage): void {
    const dataPreview = msg.data
      ? (typeof msg.data === 'string'
        ? msg.data.substring(0, 50)
        : JSON.stringify(msg.data).substring(0, 50))
      : 'undefined';

    {
      const _d = (msg.data && typeof msg.data === 'object') ? (msg.data as any) : { content: msg.data };
      const _raw = typeof _d?.content === 'string' ? _d.content : JSON.stringify(_d?.content ?? '');
      console.log(`[AgentPersonaModel] ← message on "${ agentId }"`, {
        type:         msg.type,
        id:           msg.id,
        channel:      msg.channel,
        timestamp:    msg.timestamp,
        threadId:     _d?.threadId || _d?.thread_id,
        metadata:     _d?.metadata,
        role:         _d?.role,
        kind:         _d?.kind,
        contentChars: _raw.length,
        content:      _raw.slice(0, 100),
      });
    }

    // ── Thread-ID filtering ──────────────────────────────────────────
    // If the incoming message carries a thread_id and this persona already
    // has an active threadId, drop messages that belong to a different thread.
    // Exception: workflow_execution_event messages are cross-thread by design
    // (sub-agent thread → parent orchestrator channel) so they bypass this filter.
    const msgThreadId = this.extractThreadId(msg);
    const myThreadId = this.state.threadId;
    if (msgThreadId && myThreadId && msgThreadId !== myThreadId && msg.type !== 'workflow_execution_event') {
      return; // belongs to a different chat tab — ignore
    }

    switch (msg.type) {
    case 'chat_message':
    case 'assistant_message':
    case 'user_message':
    case 'system_message': {
      this.graphRunning.value = true;
      // Store message locally - persona is source of truth
      if (msg.type === 'user_message') {
        return;
      }

      if (typeof msg.data === 'string') {
        // Skip empty or whitespace-only messages
        if (!msg.data.trim()) {
          console.warn(`⚠️ [AgentPersonaModel] EMPTY STRING assistant message dropped`, {
            msgType: msg.type, channel: agentId, threadId: msgThreadId,
            rawData: JSON.stringify(msg.data), fullMsg: JSON.stringify(msg),
          });

          return;
        }
        // Skip raw tool_use JSON that leaked from the LLM response
        if (msg.data.trimStart().startsWith('{"type":"tool_use"')) {
          console.warn(`⚠️ [AgentPersonaModel] LEAKED tool_use JSON dropped (string)`, {
            msgType: msg.type, channel: agentId, preview: msg.data.substring(0, 200),
          });

          return;
        }
        const message: ChatMessage = {
          id:        `${ Date.now() }_ws_${ msg.type }`,
          channelId: agentId,
          threadId:  msgThreadId,
          role:      msg.type === 'system_message' ? 'system' : 'assistant',
          content:   msg.data,
        };

        this.messages.push(message);

        return;
      }

      const data = (msg.data && typeof msg.data === 'object') ? (msg.data as any) : null;

      // Warn if msg.data is null/undefined or unexpected type
      if (!data) {
        console.warn(`⚠️ [AgentPersonaModel] NULL/MISSING data in assistant message dropped`, {
          msgType: msg.type, channel: agentId, threadId: msgThreadId,
          rawData: JSON.stringify(msg.data), dataType: typeof msg.data,
          fullMsg: JSON.stringify(msg),
        });

        return;
      }

      // Skip tool_use objects that leaked from the LLM response
      if (data?.type === 'tool_use') {
        console.warn(`⚠️ [AgentPersonaModel] LEAKED tool_use object dropped`, {
          msgType: msg.type, channel: agentId, toolName: data?.name,
          preview: JSON.stringify(data).substring(0, 200),
        });

        return;
      }
      const content = data?.content !== undefined ? String(data.content) : '';
      if (!content.trim()) {
        console.warn(`⚠️ [AgentPersonaModel] EMPTY CONTENT assistant message dropped`, {
          msgType: msg.type, channel: agentId, threadId: msgThreadId,
          dataKeys: Object.keys(data), rawContent: JSON.stringify(data.content),
          rawData: JSON.stringify(msg.data).substring(0, 500),
          fullMsg: JSON.stringify(msg).substring(0, 1000),
        });

        return;
      }
      // Skip if content is raw tool_use JSON
      if (content.trimStart().startsWith('{"type":"tool_use"')) {
        console.warn(`⚠️ [AgentPersonaModel] LEAKED tool_use JSON dropped (object content)`, {
          msgType: msg.type, channel: agentId, preview: content.substring(0, 200),
        });

        return;
      }

      const roleRaw = data?.role !== undefined ? String(data.role) : (msg.type === 'system_message' ? 'system' : 'assistant');
      const role = (roleRaw === 'user' || roleRaw === 'assistant' || roleRaw === 'system' || roleRaw === 'error') ? roleRaw : 'assistant';
      let kind = (typeof data?.kind === 'string') ? data.kind : undefined;
      let finalContent = content;

      // Auto-detect HTML: if the agent wraps its response in <html>...</html>,
      // treat it as an HTML message and strip the wrapper tags.
      if (!kind || kind === 'text' || kind === 'progress') {
        const htmlMatch = finalContent.match(/^\s*<html>([\s\S]*)<\/html>\s*$/i);
        if (htmlMatch) {
          kind = 'html';
          finalContent = htmlMatch[1].trim();
        }
      }
      // After all transformations, skip if content ended up empty
      if (!finalContent.trim()) {
        console.warn(`⚠️ [AgentPersonaModel] EMPTY after HTML strip — assistant message dropped`, {
          msgType: msg.type, channel: agentId, kind,
          originalContent: content.substring(0, 200),
          fullMsg: JSON.stringify(msg).substring(0, 1000),
        });

        return;
      }

      // Warn about suspicious content that IS being displayed — helps trace garbage
      const trimmed = finalContent.trim();
      const looksLikeInternalData = /^\s*[\[{]/.test(trimmed) && (
        trimmed.includes('"type"') || trimmed.includes('"tool_use"') ||
        trimmed.includes('"function"') || trimmed.includes('"tool_call"')
      );
      const isTooShort = trimmed.length > 0 && trimmed.length <= 3 && !/\w/.test(trimmed);
      if (looksLikeInternalData || isTooShort) {
        console.warn(`⚠️ [AgentPersonaModel] SUSPICIOUS assistant message ALLOWED through`, {
          msgType: msg.type, channel: agentId, threadId: msgThreadId,
          role, kind, contentLength: trimmed.length,
          contentPreview: trimmed.substring(0, 500),
          dataKeys: data ? Object.keys(data) : [],
          fullMsg: JSON.stringify(msg).substring(0, 1000),
        });
      }

      const message: ChatMessage = {
        id:        `${ Date.now() }_ws_${ msg.type }`,
        channelId: agentId,
        threadId:  msgThreadId,
        role,
        kind,
        content:   finalContent,
      };

      // Attach sender metadata for channel messages so UI can render them distinctly
      if (kind === 'channel_message') {
        message.channelMeta = {
          senderId:      typeof data?.senderId === 'string' ? data.senderId : 'unknown',
          senderChannel: typeof data?.senderChannel === 'string' ? data.senderChannel : '',
        };
      }

      this.messages.push(message);
      // Turn off loading when assistant responds
      if (role === 'assistant') {
        this.registry.setLoading(agentId, false);
      }
      return;
    }
    case 'register_or_activate_asset': {
      const data = (msg.data && typeof msg.data === 'object') ? (msg.data as any) : null;
      if (this.applyAssetLifecycleUpdate(data, 'register_or_activate_asset')) {
        return;
      }
      console.error('[AgentPersonaModel] register_or_activate_asset payload not handled', {
        reason: 'missing_or_invalid_asset_payload',
        data,
      });
      return;
    }
    case 'deactivate_asset': {
      const data = (msg.data && typeof msg.data === 'object') ? (msg.data as any) : null;
      const assetId = String(data?.assetId || '').trim();
      if (assetId) {
        this.removeAsset(assetId);
        console.log(`[AgentPersonaModel] deactivate_asset: removed ${ assetId }`);
      } else {
        console.error('[AgentPersonaModel] deactivate_asset: missing assetId', { data });
      }
      return;
    }
    case 'progress':
    case 'plan_update': {
      // Progress and plan_update messages contain plan updates, tool calls, etc.
      // StrategicStateService sends: { type: 'progress', threadId, data: { phase, ... } }
      const data = (msg.data && typeof msg.data === 'object') ? (msg.data as any) : null;
      const phase = data?.phase;

      // Handle tool_call progress events - create tool card message
      if (phase === 'tool_call') {
        const toolRunId = typeof data?.toolRunId === 'string' ? data.toolRunId : null;
        const toolName = typeof data?.toolName === 'string' ? data.toolName : 'unknown';
        const args = data?.args && typeof data.args === 'object' ? data.args : {};

        // Update the current activity status verb
        this.currentActivity.value = toolNameToVerb(toolName);

        // Skip tool cards for chat message tools - they emit directly as chat messages
        if (toolName === 'emit_chat_message' || toolName === 'emit_chat_image' || toolName === 'emit_html_message'
          || toolName === 'load_skill' || toolName === 'file_search' || toolName === 'browse_tools') {
          return;
        }

        if (toolRunId) {
          const messageId = `${ Date.now() }_tool_${ toolRunId }`;
          // Extract description from args if provided (e.g. exec tool sends description of what command does)
          const description = typeof args?.description === 'string' ? args.description : undefined;
          // Generate human-friendly display via formatter
          const display = formatToolCard(toolName, args);
          const message: ChatMessage = {
            id:        messageId,
            channelId: agentId,
            threadId:  msgThreadId,
            role:      'assistant',
            kind:      'tool',
            content:   '',
            toolCard:  {
              toolRunId,
              toolName,
              description,
              status:       'running',
              args,
              label:        display.label,
              summary:      display.summary,
              input:        display.input,
              outputFormat: display.outputFormat,
            },
          };
          this.messages.push(message);
          this.toolRunIdToMessageId.set(toolRunId, messageId);
        }
      }

      // Handle tool_result progress events - update tool card status
      if (phase === 'tool_result') {
        // Reset to "Thinking" while the LLM processes the result
        this.currentActivity.value = 'Thinking';
        const toolRunId = typeof data?.toolRunId === 'string' ? data.toolRunId : null;
        const success = data?.success === true;
        const error = typeof data?.error === 'string' ? data.error : null;
        const result = data?.result;

        if (toolRunId) {
          const messageId = this.toolRunIdToMessageId.get(toolRunId);
          if (messageId) {
            const message = this.messages.find(m => m.id === messageId);
            if (message?.toolCard) {
              message.toolCard.status = success ? 'success' : 'failed';
              message.toolCard.error = error;
              message.toolCard.result = result;
              // Populate human-friendly output from formatter
              const resultDisplay = formatToolResult(
                message.toolCard.toolName,
                message.toolCard.args ?? {},
                result,
                error,
              );
              if (resultDisplay.output) message.toolCard.output = resultDisplay.output;
              if (resultDisplay.outputFormat) message.toolCard.outputFormat = resultDisplay.outputFormat;
            }
            // Clean up the mapping
            this.toolRunIdToMessageId.delete(toolRunId);
          }
        }
      }

      return;
    }
    case 'chat_image': {
      const data = (msg.data && typeof msg.data === 'object') ? (msg.data as any) : null;

      const src = typeof data?.src === 'string' ? data.src : '';
      const alt = typeof data?.alt === 'string' ? data.alt : '';
      const path = typeof data?.path === 'string' ? data.path : '';
      const isLocal = data?.isLocal === true;

      if (!src) {
        console.log('[AgentPersonaModel] Skipping chat_image - empty src');
        return;
      }

      const roleRaw = data?.role !== undefined ? String(data.role) : 'assistant';
      const role = (roleRaw === 'user' || roleRaw === 'assistant' || roleRaw === 'system' || roleRaw === 'error')
        ? roleRaw
        : 'assistant';

      const message: ChatMessage = {
        id:        `${ Date.now() }_ws_chat_image`,
        channelId: agentId,
        threadId:  msgThreadId,
        role,
        content:   '',
        image:     {
          dataUrl: src,    // Map src to expected dataUrl property
          alt,
          path,
        },
      };

      this.messages.push(message);
      console.log('[AgentPersonaModel] Chat image stored (path/URL mode). src:', src.substring(0, 80));

      if (role === 'assistant') {
        this.registry.setLoading(agentId, false);
      }
      return;
    }
    case 'transfer_data': {
      const data = (msg.data && typeof msg.data === 'object') ? (msg.data as any) : null;
      if (data === 'graph_execution_complete' || data?.content === 'graph_execution_complete') {
        const reason = data?.stopReason || null;
        const waiting = !!(data?.waitingForUser);
        console.log('[AgentPersonaModel] Graph execution complete, stopReason:', reason, 'waitingForUser:', waiting);
        this.graphRunning.value = false;
        this.waitingForUser.value = waiting;
        this.stopReason.value = reason;
        this.registry.setLoading(agentId, false);
      }
      return;
    }
    case 'thread_created': {
      const data = (msg.data && typeof msg.data === 'object') ? (msg.data as any) : {};
      const threadId = data.threadId;

      if (threadId && typeof threadId === 'string') {
        this.setThreadId(threadId);
      }
      return;
    }
    case 'thread_restored': {
      const data = (msg.data && typeof msg.data === 'object') ? (msg.data as any) : {};
      const restoredMessages = Array.isArray(data.messages) ? data.messages : [];

      if (restoredMessages.length > 0 && this.messages.length === 0) {
        console.log(`[AgentPersonaModel] Restoring ${ restoredMessages.length } messages from thread ${ data.threadId }`);
        for (const msg of restoredMessages) {
          const role = msg.role === 'user' ? 'user' : 'assistant';
          const content = typeof msg.content === 'string' ? msg.content : '';
          if (!content.trim()) continue;
          this.messages.push({
            id:        msg.id || `restored_${ Date.now() }_${ Math.random().toString(36).slice(2, 6) }`,
            channelId: agentId,
            threadId:  msgThreadId,
            role,
            content,
            ...(typeof msg.kind === 'string' && msg.kind ? { kind: msg.kind } : {}),
          });
        }
      }
      return;
    }
    case 'token_info': {
      const data = (msg.data && typeof msg.data === 'object') ? (msg.data as any) : {};
      const tokens_used = data.tokens_used;
      const prompt_tokens = data.prompt_tokens;
      const completion_tokens = data.completion_tokens;
      const time_spent = data.time_spent;
      const threadId = data.threadId;
      const nodeId = data.nodeId;

      if (typeof tokens_used === 'number') {
        // Handle token information from completed LLM response
        this.handleTokenInfo(tokens_used, prompt_tokens, completion_tokens, time_spent, threadId, nodeId);
      }
      return;
    }
    // ── Chat-path workflow event handler ────────────────────────────────
    // Creates and updates ChatMessage objects (kind: 'workflow_node') in the
    // reactive messages array so the chat UI shows workflow progress cards.
    //
    // This is one of TWO independent consumers of `workflow_execution_event`:
    //   1. EditorChatInterface → AgentEditor.vue → WorkflowEditor.vue (canvas)
    //   2. This handler (chat message cards via WorkflowNodeCard.vue)
    //
    // Both listen on the same WebSocket channel. The event payload is emitted
    // by Graph.emitPlaybookEvent() in the main process.
    //
    // Events handled here:
    //   - workflow_started   → creates a "Workflow Started" card (status: running)
    //   - node_started       → creates a new running node card
    //   - node_completed     → finds running card by nodeId, updates to completed
    //   - node_failed        → finds running card by nodeId, updates to failed
    //   - node_waiting       → finds running card by nodeId, updates to waiting
    //   - workflow_completed → finds start card, updates to completed
    //   - workflow_failed    → finds start card, updates to failed
    //
    // Events NOT handled here (canvas-only):
    //   - edge_activated
    // Events handled as sub-agent activity bubbles:
    //   - node_thinking         → creates/updates sub_agent_activity card
    //   - sub_agent_completed   → updates sub_agent_activity card to completed
    //   - sub_agent_failed      → updates sub_agent_activity card to failed
    case 'workflow_execution_event': {
      const data = (msg.data && typeof msg.data === 'object') ? (msg.data as any) : null;
      if (!data) return;
      console.log(`[AgentPersona:chat-path] workflow_execution_event received — type="${ data.type }", nodeId="${ data.nodeId || '' }", channel="${ agentId }"`);

      const eventType: string = data.type || '';
      const nodeId: string = data.nodeId || '';
      const nodeLabel: string = data.nodeLabel || '';
      const workflowRunId: string = data.thread_id || `wf_${ Date.now() }`;
      const totalNodes: number = typeof data.totalNodes === 'number' ? data.totalNodes : 0;
      const nodeIndex: number = typeof data.nodeIndex === 'number' ? data.nodeIndex : 0;

      if (eventType === 'workflow_started') {
        // Push a workflow-started card so the user sees the workflow kicked off
        this.messages.push({
          id:        `${ Date.now() }_wf_started`,
          channelId: agentId,
          threadId:  msgThreadId,
          role:      'assistant',
          kind:      'workflow_node',
          content:   '',
          workflowNode: {
            workflowRunId,
            nodeId:     '',
            nodeLabel:  'Workflow Started',
            status:     'running',
            nodeIndex:  0,
            totalNodes,
          },
        });
        return;
      }

      if (eventType === 'node_started') {
        // Push a new running node card
        const messageId = `${ Date.now() }_wf_node_${ nodeId }`;
        this.messages.push({
          id:        messageId,
          channelId: agentId,
          threadId:  msgThreadId,
          role:      'assistant',
          kind:      'workflow_node',
          content:   '',
          workflowNode: {
            workflowRunId,
            nodeId,
            nodeLabel,
            status:    'running',
            prompt:    typeof data.prompt === 'string' ? data.prompt : undefined,
            nodeIndex,
            totalNodes,
          },
        });
        return;
      }

      if (eventType === 'node_completed' || eventType === 'node_failed' || eventType === 'node_waiting') {
        // Find the existing card for this node and update it in place
        const existing = [...this.messages].reverse().find(
          m => m.workflowNode?.nodeId === nodeId && m.workflowNode?.status === 'running',
        );
        if (existing?.workflowNode) {
          existing.workflowNode.status = eventType === 'node_completed' ? 'completed'
            : eventType === 'node_failed' ? 'failed'
              : 'waiting';
          if (data.output !== undefined) {
            existing.workflowNode.output = typeof data.output === 'string'
              ? data.output
              : JSON.stringify(data.output);
          }
          if (data.error) {
            existing.workflowNode.error = String(data.error);
          }
          if (totalNodes > 0) existing.workflowNode.totalNodes = totalNodes;
          if (nodeIndex > 0) existing.workflowNode.nodeIndex = nodeIndex;
        }
        return;
      }

      if (eventType === 'workflow_completed' || eventType === 'workflow_failed') {
        // Update the workflow-started card
        const startCard = [...this.messages].reverse().find(
          m => m.workflowNode?.nodeLabel === 'Workflow Started' && m.workflowNode?.status === 'running',
        );
        if (startCard?.workflowNode) {
          startCard.workflowNode.status = eventType === 'workflow_completed' ? 'completed' : 'failed';
          if (data.error) startCard.workflowNode.error = String(data.error);
        }
      }
      // ── Sub-agent activity: node_thinking → create/update activity bubble ──
      if (eventType === 'node_thinking') {
        const thinkingContent = typeof data.content === 'string' ? data.content : '';
        if (!thinkingContent || !nodeId) {
          console.warn(`[AgentPersona:chat-path] node_thinking SKIPPED — empty content or nodeId`, { thinkingContent: thinkingContent?.slice(0, 50), nodeId });
          return;
        }

        // Find existing running sub_agent_activity card for this nodeId
        const existing = [...this.messages].reverse().find(
          m => m.subAgentActivity?.nodeId === nodeId && m.subAgentActivity?.status === 'running',
        );

        if (existing?.subAgentActivity) {
          // Append to thinking lines
          console.log(`[AgentPersona:chat-path] node_thinking UPDATE — nodeId="${ nodeId }", lines=${ existing.subAgentActivity.thinkingLines.length + 1 }, preview="${ thinkingContent.slice(0, 60) }"`);
          existing.subAgentActivity.thinkingLines.push(thinkingContent);
          existing.subAgentActivity.latestThinking = thinkingContent;
        } else {
          // Create a new sub_agent_activity card
          console.log(`[AgentPersona:chat-path] node_thinking CREATE — nodeId="${ nodeId }", label="${ nodeLabel || nodeId }", preview="${ thinkingContent.slice(0, 60) }"`);
          this.messages.push({
            id:        `${ Date.now() }_sub_agent_${ nodeId }`,
            channelId: agentId,
            threadId:  msgThreadId,
            role:      'assistant',
            kind:      'sub_agent_activity',
            content:   '',
            subAgentActivity: {
              nodeId,
              nodeLabel: nodeLabel || nodeId,
              status:    'running',
              thinkingLines:  [thinkingContent],
              latestThinking: thinkingContent,
            },
          });
        }
        return;
      }

      // ── Sub-agent activity: blocked → escalating question to orchestrator ──
      if (eventType === 'sub_agent_blocked') {
        const existing = [...this.messages].reverse().find(
          m => m.subAgentActivity?.nodeId === nodeId && m.subAgentActivity?.status === 'running',
        );
        if (existing?.subAgentActivity) {
          existing.subAgentActivity.status = 'blocked';
          const question = typeof data.question === 'string' ? data.question : '';
          if (question) {
            existing.subAgentActivity.thinkingLines.push(`[Asking orchestrator] ${ question }`);
            existing.subAgentActivity.latestThinking = 'Waiting for orchestrator...';
          }
        }
        return;
      }

      // ── Sub-agent activity: completion/failure → update activity bubble status ──
      if (eventType === 'sub_agent_completed' || eventType === 'sub_agent_failed') {
        const existing = [...this.messages].reverse().find(
          m => m.subAgentActivity?.nodeId === nodeId &&
               (m.subAgentActivity?.status === 'running' || m.subAgentActivity?.status === 'blocked'),
        );
        if (existing?.subAgentActivity) {
          existing.subAgentActivity.status = eventType === 'sub_agent_completed' ? 'completed' : 'failed';
          if (data.output !== undefined) {
            existing.subAgentActivity.output = typeof data.output === 'string'
              ? data.output
              : JSON.stringify(data.output);
          }
          if (data.error) {
            existing.subAgentActivity.error = String(data.error);
          }
        }
        return;
      }

      // edge_activated and other sub-events are visual-only (canvas), skip chat
      return;
    }
    case 'ack':
    case 'ping':
    case 'pong':
    case 'subscribe':
      // Silent — these are protocol-level messages, not content
      return;
    default:
      console.log('[AgentPersonaModel] Unhandled message type:', msg.type);
    }
  }

  /**
   * Handle token information from completed LLM response
   */
  private handleTokenInfo(
    tokens_used: number,
    prompt_tokens: number,
    completion_tokens: number,
    time_spent: number,
    threadId?: string,
    nodeId?: string,
  ): void {
    // XAI Grok pricing
    const costPerMillionInputTokens = 0.50; // $0.50 per 1M input tokens
    const costPerMillionOutputTokens = 1.50; // $1.50 per 1M output tokens

    // Calculate costs for this response
    const inputCost = (prompt_tokens * costPerMillionInputTokens) / 1000000;
    const outputCost = (completion_tokens * costPerMillionOutputTokens) / 1000000;
    const totalResponseCost = inputCost + outputCost;

    // Update token tracking properties
    this.state.totalTokensUsed += tokens_used;
    this.state.totalPromptTokens += prompt_tokens;
    this.state.totalCompletionTokens += completion_tokens;
    this.state.lastResponseTime = time_spent;
    this.state.responseCount++;

    // Update cost tracking properties
    this.state.totalInputCost += inputCost;
    this.state.totalOutputCost += outputCost;
    this.state.totalCost += totalResponseCost;

    // Calculate rolling average response time
    this.state.averageResponseTime =
      (this.state.averageResponseTime * (this.state.responseCount - 1) + time_spent) / this.state.responseCount;
  }

  set emotion(value: PersonaEmotion) {
    this.state.emotion = value;
  }

  get emotion(): PersonaEmotion {
    return this.state.emotion;
  }

  set templateId(value: PersonaTemplateId) {
    this.state.templateId = value;
  }

  get templateId(): PersonaTemplateId {
    return this.state.templateId;
  }

  set agentId(value: string) {
    this.state.agentId = value;
  }

  get agentId(): string {
    return this.state.agentId;
  }

  set agentName(value: string) {
    this.state.agentName = value;
  }

  get agentName(): string {
    return this.state.agentName;
  }

  set status(value: PersonaStatus) {
    this.state.status = value;
  }

  get status(): PersonaStatus {
    return this.state.status;
  }

  set tokensPerSecond(value: number) {
    this.state.tokensPerSecond = value;
  }

  get tokensPerSecond(): number {
    return this.state.tokensPerSecond;
  }

  set temperature(value: number) {
    this.state.temperature = value;
  }

  get temperature(): number {
    return this.state.temperature;
  }
}

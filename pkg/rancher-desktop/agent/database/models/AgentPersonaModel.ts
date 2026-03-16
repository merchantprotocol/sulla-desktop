// AgentPersonaService.ts
import { computed, reactive, ref } from 'vue';
import { getWebSocketClientService, type WebSocketMessage } from '@pkg/agent/services/WebSocketClientService';
import { AgentPersonaRegistry } from '../registry/AgentPersonaRegistry';
import type { ChatMessage, AgentRegistryEntry } from '../registry/AgentPersonaRegistry';

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
  // Filesystem
  fs_read_file: 'Reading', fs_write_file: 'Writing', fs_append_file: 'Writing',
  fs_list_dir: 'Browsing files', fs_mkdir: 'Creating folder', fs_path_info: 'Inspecting',
  fs_copy_path: 'Copying', fs_move_path: 'Moving', fs_delete_path: 'Deleting',
  // Execution
  exec: 'Running', exec_command: 'Running', shell: 'Running', bash: 'Running', run_command: 'Running',
  // Search
  meta_search: 'Searching', browse_tools: 'Searching tools',
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
  execute_workflow: 'Running workflow', create_workflow: 'Creating workflow',
  update_workflow: 'Updating workflow', validate_workflow: 'Validating workflow',
  patch_workflow: 'Patching workflow', activate_workflow: 'Activating workflow',
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

  private refreshWebSocketService(): void {
    // Clone/refresh the service to avoid corruption from multiple connection attempts
    this.wsService = getWebSocketClientService();
  }

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

    console.log(`[AgentPersona:${ this.state.agentName }] Connecting WebSocket for ${ id }`);

    const maxAttempts = 3;
    let attempts = 0;

    const attemptConnect = () => {
      attempts++;
      this.refreshWebSocketService(); // Clone/refresh service for each attempt
      this.wsService.connect(id);

      const unsub = this.wsService.onMessage(id, (msg: WebSocketMessage) => {
        this.handleWebSocketMessage(id, msg);
      });

      if (unsub) {
        this.wsUnsub.set(id, unsub);
        console.log(`[AgentPersona:${ this.state.agentName }] WebSocket connected successfully on attempt ${ attempts }`);
      } else if (attempts < maxAttempts) {
        console.warn(`[AgentPersona:${ this.state.agentName }] WebSocket connection attempt ${ attempts } failed, retrying...`);
        setTimeout(attemptConnect, 1000 * attempts); // Exponential backoff
      } else {
        console.error(`[AgentPersona:${ this.state.agentName }] Failed to connect WebSocket after ${ maxAttempts } attempts`);
      }
    };

    attemptConnect();
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

  private handleWebSocketMessage(agentId: string, msg: WebSocketMessage): void {
    const dataPreview = msg.data
      ? (typeof msg.data === 'string'
        ? msg.data.substring(0, 50)
        : JSON.stringify(msg.data).substring(0, 50))
      : 'undefined';

    // ── Thread-ID filtering ──────────────────────────────────────────
    // If the incoming message carries a thread_id and this persona already
    // has an active threadId, drop messages that belong to a different thread.
    const msgThreadId = this.extractThreadId(msg);
    const myThreadId = this.state.threadId;
    if (msgThreadId && myThreadId && msgThreadId !== myThreadId) {
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
        // Skip raw tool_use JSON that leaked from the LLM response
        if (msg.data.trimStart().startsWith('{"type":"tool_use"')) return;
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
      // Skip tool_use objects that leaked from the LLM response
      if (data?.type === 'tool_use') return;
      const content = data?.content !== undefined ? String(data.content) : '';
      if (!content.trim()) {
        return;
      }
      // Skip if content is raw tool_use JSON
      if (content.trimStart().startsWith('{"type":"tool_use"')) return;

      const roleRaw = data?.role !== undefined ? String(data.role) : (msg.type === 'system_message' ? 'system' : 'assistant');
      const role = (roleRaw === 'user' || roleRaw === 'assistant' || roleRaw === 'system' || roleRaw === 'error') ? roleRaw : 'assistant';
      const kind = (typeof data?.kind === 'string') ? data.kind : undefined;

      const message: ChatMessage = {
        id:        `${ Date.now() }_ws_${ msg.type }`,
        channelId: agentId,
        threadId:  msgThreadId,
        role,
        kind,
        content,
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
        if (toolName === 'emit_chat_message' || toolName === 'emit_chat_image') {
          return;
        }

        if (toolRunId) {
          const messageId = `${ Date.now() }_tool_${ toolRunId }`;
          // Extract description from args if provided (e.g. exec tool sends description of what command does)
          const description = typeof args?.description === 'string' ? args.description : undefined;
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
              status: 'running',
              args,
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

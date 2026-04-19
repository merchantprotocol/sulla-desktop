// AgentPersonaService.ts
import { computed, reactive, ref } from 'vue';

import { createMessageDispatcher, type DispatchContext } from './MessageDispatcher';
import { AgentPersonaRegistry } from '../registry/AgentPersonaRegistry';

import { getWebSocketClientService, type WebSocketMessage } from '@pkg/agent/services/WebSocketClientService';
import { personaLogger as console } from '@pkg/agent/utils/agentLogger';

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

export type PersonaAssetType = 'browser' | 'document';

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

export class AgentPersonaService {
  private readonly registry: AgentPersonaRegistry;
  private wsService = getWebSocketClientService();
  private readonly wsUnsub = new Map<string, () => void>();
  private readonly dispatcher = createMessageDispatcher();

  readonly messages:     ChatMessage[] = reactive([]);
  private readonly toolRunIdToMessageId = new Map<string, string>();
  readonly activeAssets: PersonaSidebarAsset[] = reactive([]);

  /**
   * Direct speak event listeners — allows VoicePipeline to receive speak events
   * without watching the messages array (lower latency, no deep watcher overhead).
   */
  private readonly speakListeners: ((text: string, threadId: string, pipelineSequence: number | null) => void)[] = [];

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
      id:        input.id,
      url,
      skillSlug: input.skillSlug || '',
    });

    this.upsertAsset({
      id:        input.id,
      type:      'browser',
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

    if (asset?.type === 'browser') {
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
    const hasAttachments = Array.isArray(extraMetadata?.attachments) && (extraMetadata.attachments).length > 0;
    if (!content.trim() && !hasAttachments) return false;

    const id = this.state.agentId;
    console.log(`[AgentPersonaService] _addUserMessage() — channel="${ id }", threadId="${ this.state.threadId || '(none)' }", content="${ content.slice(0, 80) }"`);
    this.stopReason.value = null;
    this.waitingForUser.value = false;
    this.currentActivity.value = 'Thinking';

    // Build local message with optional image preview for the chat UI
    const attachments = extraMetadata?.attachments as any[] | undefined;
    const firstImage = attachments?.find((a: any) => a?.type === 'image' && a?.source?.data);
    const localMessage: any = {
      id:        `user_${ Date.now() }_${ Math.random().toString(36).slice(2, 8) }`,
      channelId: id,
      threadId:  this.state.threadId,
      role:      'user',
      content:   content || (firstImage ? '(image attached)' : ''),
    };
    if (firstImage) {
      localMessage.image = {
        dataUrl:     `data:${ firstImage.source.media_type };base64,${ firstImage.source.data }`,
        contentType: firstImage.source.media_type,
      };
    }
    this.messages.push(localMessage);

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

  /**
   * Inject a message into the running graph's state without triggering a new
   * graph execution cycle.  The message is appended to state.messages so the
   * graph picks it up on its next natural loop iteration.
   *
   * If the backend cannot find a running state (race — graph already finished),
   * it falls back to a full dispatch which starts a new execution cycle.
   */
  async injectMessage(content: string, extraMetadata?: Record<string, unknown>): Promise<boolean> {
    if (!content.trim()) return false;

    const id = this.state.agentId;
    console.log(`[AgentPersonaService] injectMessage() — channel="${ id }", threadId="${ this.state.threadId || '(none)' }", content="${ content.slice(0, 80) }"`);

    // Optimistic UI — push the user message locally so it appears in chat immediately
    const attachments = extraMetadata?.attachments as any[] | undefined;
    const firstImage = attachments?.find((a: any) => a?.type === 'image' && a?.source?.data);
    const localMessage: any = {
      id:        `user_${ Date.now() }_${ Math.random().toString(36).slice(2, 8) }`,
      channelId: id,
      threadId:  this.state.threadId,
      role:      'user',
      content:   content || (firstImage ? '(image attached)' : ''),
    };
    if (firstImage) {
      localMessage.image = {
        dataUrl:     `data:${ firstImage.source.media_type };base64,${ firstImage.source.data }`,
        contentType: firstImage.source.media_type,
      };
    }
    this.messages.push(localMessage);

    // Send inject_message — backend will push to state.messages without calling graph.execute()
    let delivered: boolean;
    try {
      delivered = await this.wsService.send(id, {
        type:      'inject_message',
        data:      { role: 'user', content, threadId: this.state.threadId, metadata: extraMetadata },
        timestamp: Date.now(),
      });
      console.log(`[AgentPersonaService] injectMessage() — WebSocket send result: delivered=${ delivered }`);
    } catch (err) {
      console.error(`[AgentPersonaService] injectMessage() — WebSocket send THREW:`, err);
      delivered = false;
    }

    if (!delivered) {
      console.warn(`[AgentPersonaService] Inject delivery FAILED for channel="${ id }"`);
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

  /**
   * Register a listener for direct speak event delivery.
   * Returns an unsubscribe function.
   */
  addSpeakListener(cb: (text: string, threadId: string, pipelineSequence: number | null) => void): () => void {
    this.speakListeners.push(cb);

    return () => {
      const idx = this.speakListeners.indexOf(cb);
      if (idx !== -1) this.speakListeners.splice(idx, 1);
    };
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
      return typeof d.thread_id === 'string'
        ? d.thread_id
        : typeof d.threadId === 'string'
          ? d.threadId
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
    // ── Thread-ID filtering ──────────────────────────────────────────
    const msgThreadId = this.extractThreadId(msg);
    const myThreadId = this.state.threadId;

    // Drop messages that don't carry a threadId when we already have an active thread.
    // This prevents stray workflow / backend messages from leaking into the chat.
    if (!msgThreadId && myThreadId) {
      // Allow protocol-level messages that never carry a threadId
      const threadExempt = msg.type === 'thread_created' || msg.type === 'ack' ||
        msg.type === 'ping' || msg.type === 'pong' || msg.type === 'subscribe';
      if (!threadExempt) {
        return;
      }
    }

    if (msgThreadId && myThreadId && msgThreadId !== myThreadId) {
      return; // belongs to a different chat tab — ignore
    }

    this.dispatcher.dispatch(this.getDispatchContext(), agentId, msgThreadId ?? '', msg);
  }

  /**
   * Builds the DispatchContext that message handlers need to access shared state.
   */
  private getDispatchContext(): DispatchContext {
    return {
      messages:                  this.messages,
      graphRunning:              this.graphRunning,
      waitingForUser:            this.waitingForUser,
      stopReason:                this.stopReason,
      currentActivity:           this.currentActivity,
      registry:                  this.registry,
      toolRunIdToMessageId:      this.toolRunIdToMessageId,
      speakListeners:            this.speakListeners,
      setThreadId:               (id: string) => this.setThreadId(id),
      getThreadId:               () => this.getThreadId(),
      handleTokenInfo:           (...args) => this.handleTokenInfo(...args),
      applyAssetLifecycleUpdate: (data: any, type: string) => this.applyAssetLifecycleUpdate(data, type),
      removeAsset:               (id: string) => this.removeAsset(id),
    };
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

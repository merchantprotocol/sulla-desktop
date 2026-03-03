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

export type AgentPersonaState = {
  agentId: string;
  agentName: string;

  templateId: PersonaTemplateId;
  emotion: PersonaEmotion;

  status: PersonaStatus;

  tokensPerSecond: number;
  temperature: number;
  threadId?: string;

  // Token tracking properties
  totalTokensUsed: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  lastResponseTime: number;
  averageResponseTime: number;
  responseCount: number;
  
  // Cost tracking properties (XAI Grok pricing)
  totalInputCost: number;
  totalOutputCost: number;
  totalCost: number;
};

export type PersonaAssetType = 'iframe' | 'document';

export type PersonaSidebarAsset = {
  id: string;
  type: PersonaAssetType;
  title: string;
  active: boolean;
  skillSlug?: string;
  collapsed: boolean;
  updatedAt: number;
  url?: string;
  content?: string;
  refKey?: string;
};

export class AgentPersonaService {
  private readonly registry: AgentPersonaRegistry;
  private wsService = getWebSocketClientService();
  private readonly wsUnsub = new Map<string, () => void>();
  private lastSentN8nLiveEventsEnabled: boolean | null = null;

  readonly messages: ChatMessage[] = reactive([]);
  private readonly toolRunIdToMessageId = new Map<string, string>();
  readonly activeAssets: PersonaSidebarAsset[] = reactive([]);

  graphRunning = ref(false);
  stopReason = ref<string | null>(null);


  readonly state = reactive<AgentPersonaState>({
    agentId: 'unit-01',
    agentName: 'UNIT_01',

    templateId: 'glass-core',
    emotion: 'calm',

    status: 'online',

    tokensPerSecond: 847,
    temperature: 0.7,

    // Token tracking initialization
    totalTokensUsed: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    lastResponseTime: 0,
    averageResponseTime: 0,
    responseCount: 0,
    
    // Cost tracking initialization (XAI Grok pricing)
    totalInputCost: 0,
    totalOutputCost: 0,
    totalCost: 0,
  });

  readonly emotionClass = computed(() => `persona-profile-${this.state.emotion}`);

  private refreshWebSocketService(): void {
    // Clone/refresh the service to avoid corruption from multiple connection attempts
    this.wsService = getWebSocketClientService();
  }

  constructor(registry: AgentPersonaRegistry, agentData?: AgentRegistryEntry) {
    this.registry = registry;

    if (agentData) {
      Object.assign(this.state, {
        agentId: agentData.agentId,
        agentName: agentData.agentName,
        templateId: agentData.templateId,
        emotion: agentData.emotion,
        status: agentData.status,
        tokensPerSecond: agentData.tokensPerSecond ?? 847,
        temperature: agentData.temperature ?? 0.7,
        totalTokensUsed: agentData.totalTokensUsed ?? 0,
      });
    }

    // Connect immediately — this is the core fix
    this.connectAndListen();
  }

  registerIframeAsset(input: {
    id: string;
    title: string;
    url: string;
    active?: boolean;
    skillSlug?: string;
    collapsed?: boolean;
    refKey?: string;
  }): void {
    const stableId = this.resolveWebsiteAssetId(input.id, input.skillSlug);
    const normalizedUrl = this.normalizeIframeUrlForAsset(stableId, input.skillSlug, input.url);
    const existingAsset = this.activeAssets.find((asset) => asset.id === stableId && asset.type === 'iframe');
    const fallbackUrl = existingAsset?.url || '';
    const effectiveUrl = normalizedUrl || fallbackUrl;

    console.log('[AgentPersonaModel] registerIframeAsset', {
      requestedId: input.id,
      stableId,
      skillSlug: input.skillSlug || '',
      requestedUrl: input.url || '',
      normalizedUrl,
      fallbackUrl,
      effectiveUrl,
      hadExistingAsset: !!existingAsset,
    });

    if (!effectiveUrl.trim()) {
      console.error('[AgentPersonaModel] registerIframeAsset produced empty iframe src', input);
      return;
    }

    this.upsertAsset({
      id: stableId,
      type: 'iframe',
      title: input.title,
      active: input.active ?? effectiveUrl.trim().length > 0,
      skillSlug: input.skillSlug,
      collapsed: input.collapsed ?? true,
      updatedAt: Date.now(),
      url: effectiveUrl,
      refKey: input.refKey,
    });
  }

  private normalizeSkillSlug(value: unknown): string {
    if (typeof value !== 'string') {
      return '';
    }
    return value.trim().toLowerCase();
  }

  private getStableWebsiteAssetIdForSkill(skillSlug: string): string | null {
    if (!skillSlug) {
      return null;
    }

    if (skillSlug.includes('workflow')) {
      return 'sulla_n8n';
    }

    return null;
  }

  private resolveWebsiteAssetId(candidateId: string, skillSlug?: string): string {
    const normalizedSkillSlug = this.normalizeSkillSlug(skillSlug);
    const stableSkillId = this.getStableWebsiteAssetIdForSkill(normalizedSkillSlug);
    if (stableSkillId) {
      return stableSkillId;
    }
    return candidateId;
  }

  private isN8nWorkflowAsset(assetId: string, skillSlug?: string): boolean {
    const normalizedSkillSlug = this.normalizeSkillSlug(skillSlug);
    return assetId === 'sulla_n8n' || normalizedSkillSlug.includes('workflow');
  }

  private normalizeIframeUrlForAsset(assetId: string, skillSlug: string | undefined, url: string): string {
    const trimmed = String(url || '').trim();
    if (!trimmed) {
      return '';
    }

    if (!this.isN8nWorkflowAsset(assetId, skillSlug)) {
      return trimmed;
    }

    try {
      const parsed = new URL(trimmed);
      return `${parsed.origin}/`;
    } catch {
      return trimmed;
    }
  }

  private applyAssetLifecycleUpdate(data: any, phase: string): boolean {
    const asset = (data?.asset && typeof data.asset === 'object') ? data.asset as any : null;
    if (!asset) {
      return false;
    }

    if (asset?.type === 'iframe') {
      const skillSlug = this.normalizeSkillSlug(asset.skillSlug ?? asset.selected_skill_slug ?? data?.selected_skill_slug);
      const requestedId = String(asset.id || `iframe_${Date.now()}`);
      const requestedUrl = String(asset.url || '');

      console.log('[AgentPersonaModel] websocket asset lifecycle iframe', {
        phase,
        requestedId,
        requestedUrl,
        skillSlug,
        active: asset.active !== false,
        collapsed: asset.collapsed !== false,
      });

      this.registerIframeAsset({
        id: requestedId,
        title: String(asset.title || 'Website'),
        url: requestedUrl,
        active: asset.active !== false,
        skillSlug: skillSlug || undefined,
        collapsed: asset.collapsed !== false,
        refKey: typeof asset.refKey === 'string' ? asset.refKey : undefined,
      });

      return true;
    }

    if (asset?.type === 'document') {
      const documentId = String(asset.id || `doc_${Date.now()}`);
      const content = String(asset.content || '');
      const existingDocument = this.activeAssets.find((item) => item.id === documentId && item.type === 'document');

      if (existingDocument) {
        this.updateDocumentAssetContent(documentId, content);
      } else {
        this.registerDocumentAsset({
          id: documentId,
          title: String(asset.title || 'Document'),
          content,
          active: asset.active !== false,
          collapsed: asset.collapsed !== false,
          refKey: typeof asset.refKey === 'string' ? asset.refKey : undefined,
        });
      }

      return true;
    }

    return false;
  }

  registerDocumentAsset(input: {
    id: string;
    title: string;
    content: string;
    active?: boolean;
    collapsed?: boolean;
    refKey?: string;
  }): void {
    this.upsertAsset({
      id: input.id,
      type: 'document',
      title: input.title,
      active: input.active ?? input.content.trim().length > 0,
      collapsed: input.collapsed ?? true,
      updatedAt: Date.now(),
      content: input.content,
      refKey: input.refKey,
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
      this.syncGraphRuntimeFlags();
    }
  }

  private upsertAsset(asset: PersonaSidebarAsset): void {
    const existing = this.activeAssets.find((item) => item.id === asset.id);
    if (existing) {
      Object.assign(existing, asset, { updatedAt: Date.now() });
      this.syncGraphRuntimeFlags();
      return;
    }
    this.activeAssets.push(asset);
    this.syncGraphRuntimeFlags();
  }

  private isN8nLiveEventsEnabledForCurrentAssets(): boolean {
    return this.activeAssets.some((asset) => {
      if (asset.type !== 'iframe' || asset.active !== true) {
        return false;
      }

      return this.isN8nWorkflowAsset(asset.id, asset.skillSlug);
    });
  }

  private syncGraphRuntimeFlags(): void {
    const threadId = String(this.state.threadId || '').trim();
    if (!threadId) {
      return;
    }

    const n8nLiveEventsEnabled = this.isN8nLiveEventsEnabledForCurrentAssets();
    if (this.lastSentN8nLiveEventsEnabled === n8nLiveEventsEnabled) {
      return;
    }

    this.lastSentN8nLiveEventsEnabled = n8nLiveEventsEnabled;
    void this.wsService.send(this.state.agentId, {
      type: 'graph_runtime_update',
      data: {
        threadId,
        n8nLiveEventsEnabled,
      },
      timestamp: Date.now(),
    });
  }

  private connectAndListen() {
    const id = this.state.agentId;
    if (this.wsUnsub.has(id)) return;

    console.log(`[AgentPersona:${this.state.agentName}] Connecting WebSocket for ${id}`);

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
        console.log(`[AgentPersona:${this.state.agentName}] WebSocket connected successfully on attempt ${attempts}`);
      } else if (attempts < maxAttempts) {
        console.warn(`[AgentPersona:${this.state.agentName}] WebSocket connection attempt ${attempts} failed, retrying...`);
        setTimeout(attemptConnect, 1000 * attempts); // Exponential backoff
      } else {
        console.error(`[AgentPersona:${this.state.agentName}] Failed to connect WebSocket after ${maxAttempts} attempts`);
      }
    };

    attemptConnect();
  }

  // Kept old signature for compatibility, but agentId is now ignored (service owns its channel)
  async addUserMessage(_agentId: string, content: string): Promise<boolean> {
    return this._addUserMessage(content);
  }

  // Internal clean version
  private async _addUserMessage(content: string): Promise<boolean> {
    if (!content.trim()) return false;

    const id = this.state.agentId;
    this.stopReason.value = null;

    this.messages.push({
      id: `user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      channelId: id,
      role: 'user',
      content,
    });

    this.registry.setLoading(id, true);

    return this.wsService.send(id, {
      type: 'user_message',
      data: { role: 'user', content, threadId: this.state.threadId },
      timestamp: Date.now(),
    });
  }


  setThreadId(threadId: string): void {
    this.state.threadId = threadId;
    this.lastSentN8nLiveEventsEnabled = null;
    this.syncGraphRuntimeFlags();
  }

  getThreadId(): string | undefined {
    return this.state.threadId;
  }

  clearThreadId(): void {
    this.state.threadId = undefined;
    this.lastSentN8nLiveEventsEnabled = null;
  }

  async emitContinueRun(): Promise<boolean> {
    const id = this.state.agentId;
    this.stopReason.value = null;
    this.graphRunning.value = true;
    this.registry.setLoading(id, true);

    return this.wsService.send(id, {
      type: 'continue_run',
      timestamp: Date.now(),
    });
  }

  async emitStopSignal(agentId: string): Promise<boolean> {
    console.log('[AgentPersonaModel] Emitting stop signal for agent:', agentId);
    const sent = await this.wsService.send(agentId, {
      type: 'stop_run',
      timestamp: Date.now(),
    });
    console.log('[AgentPersonaModel] Stop signal sent successfully:', sent);
    if (!sent) {
      console.warn(`[AgentPersonaService] Failed to send stop signal on ${agentId}`);
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
  }

  private handleWebSocketMessage(agentId: string, msg: WebSocketMessage): void {
    const dataPreview = msg.data
      ? (typeof msg.data === 'string'
        ? msg.data.substring(0, 50)
        : JSON.stringify(msg.data).substring(0, 50))
      : 'undefined';

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
          const message: ChatMessage = {
            id: `${Date.now()}_ws_${msg.type}`,
            channelId: agentId,
            role: msg.type === 'system_message' ? 'system' : 'assistant',
            content: msg.data,
          };
          this.messages.push(message);
          return;
        }

        const data = (msg.data && typeof msg.data === 'object') ? (msg.data as any) : null;
        const content = data?.content !== undefined ? String(data.content) : '';
        if (!content.trim()) {
          return;
        }

        const roleRaw = data?.role !== undefined ? String(data.role) : (msg.type === 'system_message' ? 'system' : 'assistant');
        const role = (roleRaw === 'user' || roleRaw === 'assistant' || roleRaw === 'system' || roleRaw === 'error') ? roleRaw : 'assistant';
        const kind = (typeof data?.kind === 'string') ? data.kind : undefined;

        const message: ChatMessage = {
          id: `${Date.now()}_ws_${msg.type}`,
          channelId: agentId,
          role,
          kind,
          content,
        };

        // Attach sender metadata for channel messages so UI can render them distinctly
        if (kind === 'channel_message') {
          message.channelMeta = {
            senderId: typeof data?.senderId === 'string' ? data.senderId : 'unknown',
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
          console.log(`[AgentPersonaModel] deactivate_asset: removed ${assetId}`);
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
          
          // Skip tool cards for chat message tools - they emit directly as chat messages
          if (toolName === 'emit_chat_message' || toolName === 'emit_chat_image') {
            return;
          }
          
          if (toolRunId) {
            const messageId = `${Date.now()}_tool_${toolRunId}`;
            const message: ChatMessage = {
              id: messageId,
              channelId: agentId,
              role: 'assistant',
              kind: 'tool',
              content: '',
              toolCard: {
                toolRunId,
                toolName,
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
          const toolRunId = typeof data?.toolRunId === 'string' ? data.toolRunId : null;
          const success = data?.success === true;
          const error = typeof data?.error === 'string' ? data.error : null;
          const result = data?.result;
          
          if (toolRunId) {
            const messageId = this.toolRunIdToMessageId.get(toolRunId);
            if (messageId) {
              const message = this.messages.find(m => m.id === messageId);
              if (message && message.toolCard) {
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
        
        const src      = typeof data?.src === 'string' ? data.src : '';
        const alt      = typeof data?.alt === 'string' ? data.alt : '';
        const path     = typeof data?.path === 'string' ? data.path : '';
        const isLocal  = data?.isLocal === true;

        if (!src) {
          console.log('[AgentPersonaModel] Skipping chat_image - empty src');
          return;
        }

        const roleRaw = data?.role !== undefined ? String(data.role) : 'assistant';
        const role = (roleRaw === 'user' || roleRaw === 'assistant' || roleRaw === 'system' || roleRaw === 'error') 
          ? roleRaw 
          : 'assistant';

        const message: ChatMessage = {
          id: `${Date.now()}_ws_chat_image`,
          channelId: agentId,
          role,
          content: '',
          image: {
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
          console.log('[AgentPersonaModel] Graph execution complete, stopReason:', reason);
          this.graphRunning.value = false;
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
    nodeId?: string
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

/**
 * MessageDispatcher — handler registry for WebSocket message types.
 *
 * Replaces the monolithic switch statement in AgentPersonaService.handleWebSocketMessage()
 * with a type → handler map. Each handler is a standalone function that receives a
 * DispatchContext for accessing shared state (messages, refs, helpers).
 *
 * To add a new message type:
 *   1. Write a handler function: (ctx, agentId, threadId, msg) => void
 *   2. Register it: dispatcher.register('my_type', myHandler)
 *
 * Handler functions are testable in isolation — they only depend on DispatchContext,
 * not on the full AgentPersonaService.
 */

import type { Ref } from 'vue';
import type { WebSocketMessage } from '@pkg/agent/services/WebSocketClientService';
import type { ChatMessage } from '../registry/AgentPersonaRegistry';
import type { AgentPersonaRegistry } from '../registry/AgentPersonaRegistry';
import { formatToolCard, formatToolResult } from '@pkg/agent/tools/toolCardFormatters';
import { dispatchLogger as console } from '@pkg/agent/utils/agentLogger';

// ─── Types ──────────────────────────────────────────────────────

export type SpeakListener = (text: string, threadId: string, pipelineSequence: number | null) => void;

/**
 * Shared state and helpers that handlers need from AgentPersonaService.
 * Constructed once and passed to all handlers.
 */
export interface DispatchContext {
  messages:             ChatMessage[];
  graphRunning:         Ref<boolean>;
  waitingForUser:       Ref<boolean>;
  stopReason:           Ref<string | null>;
  currentActivity:      Ref<string>;
  registry:             AgentPersonaRegistry;
  toolRunIdToMessageId: Map<string, string>;
  speakListeners:       SpeakListener[];

  setThreadId(threadId: string): void;
  handleTokenInfo(
    tokens_used: number,
    prompt_tokens: number,
    completion_tokens: number,
    time_spent: number,
    threadId?: string,
    nodeId?: string,
  ): void;
  applyAssetLifecycleUpdate(data: any, type: string): boolean;
  removeAsset(assetId: string): void;
}

export type MessageHandler = (
  ctx: DispatchContext,
  agentId: string,
  threadId: string,
  msg: WebSocketMessage,
) => void;

// ─── Dispatcher ─────────────────────────────────────────────────

export class MessageDispatcher {
  private readonly handlers = new Map<string, MessageHandler>();

  register(type: string, handler: MessageHandler): void {
    this.handlers.set(type, handler);
  }

  dispatch(ctx: DispatchContext, agentId: string, threadId: string, msg: WebSocketMessage): void {
    const handler = this.handlers.get(msg.type);
    if (handler) {
      handler(ctx, agentId, threadId, msg);
    } else {
      console.log('[MessageDispatcher] Unhandled message type:', msg.type);
    }
  }
}

// ─── Handler: chat / assistant / system messages ────────────────

function handleChatMessage(ctx: DispatchContext, agentId: string, msgThreadId: string, msg: WebSocketMessage): void {
  ctx.graphRunning.value = true;

  // user_message: already pushed locally before send — skip
  if (msg.type === 'user_message') return;

  // ── String payload (simple content) ──
  if (typeof msg.data === 'string') {
    if (!msg.data.trim()) {
      console.warn(`⚠️ [MessageDispatcher] EMPTY STRING assistant message dropped`, {
        msgType: msg.type, channel: agentId, threadId: msgThreadId,
      });
      return;
    }
    if (msg.data.trimStart().startsWith('{"type":"tool_use"')) {
      console.warn(`⚠️ [MessageDispatcher] LEAKED tool_use JSON dropped (string)`, {
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
    console.log(`[MessageDispatcher] messages.push (string ${ msg.type })`, { role: message.role, contentChars: message.content.length, content: message.content.slice(0, 120) });
    ctx.messages.push(message);
    return;
  }

  // ── Object payload ──
  const data = (msg.data && typeof msg.data === 'object') ? (msg.data as any) : null;
  if (!data) {
    console.warn(`⚠️ [MessageDispatcher] NULL/MISSING data in assistant message dropped`, {
      msgType: msg.type, channel: agentId, threadId: msgThreadId,
    });
    return;
  }
  if (data?.type === 'tool_use') {
    console.warn(`⚠️ [MessageDispatcher] LEAKED tool_use object dropped`, {
      msgType: msg.type, channel: agentId, toolName: data?.name,
    });
    return;
  }

  const content = data?.content !== undefined ? String(data.content) : '';
  if (!content.trim()) {
    console.warn(`⚠️ [MessageDispatcher] EMPTY CONTENT assistant message dropped`, {
      msgType: msg.type, channel: agentId, threadId: msgThreadId,
    });
    return;
  }
  if (content.trimStart().startsWith('{"type":"tool_use"')) {
    console.warn(`⚠️ [MessageDispatcher] LEAKED tool_use JSON dropped (object content)`, {
      msgType: msg.type, channel: agentId, preview: content.substring(0, 200),
    });
    return;
  }

  const roleRaw = data?.role !== undefined ? String(data.role) : (msg.type === 'system_message' ? 'system' : 'assistant');
  const role = (roleRaw === 'user' || roleRaw === 'assistant' || roleRaw === 'system' || roleRaw === 'error') ? roleRaw : 'assistant';
  let kind = (typeof data?.kind === 'string') ? data.kind : undefined;
  let finalContent = content;

  if (kind === 'speak') {
    console.log(`[MessageDispatcher] SPEAK received → channel="${agentId}", thread="${msgThreadId}", content="${content.slice(0, 80)}"`);
  }

  // Auto-detect HTML
  if (!kind || kind === 'text' || kind === 'progress') {
    const htmlMatch = finalContent.match(/^\s*<html>([\s\S]*)<\/html>\s*$/i);
    if (htmlMatch) {
      kind = 'html';
      finalContent = htmlMatch[1].trim();
    }
  }

  if (!finalContent.trim()) {
    console.warn(`⚠️ [MessageDispatcher] EMPTY after HTML strip — assistant message dropped`, {
      msgType: msg.type, channel: agentId, kind,
    });
    return;
  }

  // Warn about suspicious content
  const trimmed = finalContent.trim();
  const looksLikeInternalData = /^\s*[\[{]/.test(trimmed) && (
    trimmed.includes('"type"') || trimmed.includes('"tool_use"') ||
    trimmed.includes('"function"') || trimmed.includes('"tool_call"')
  );
  const isTooShort = trimmed.length > 0 && trimmed.length <= 3 && !/\w/.test(trimmed);
  if (looksLikeInternalData || isTooShort) {
    console.warn(`⚠️ [MessageDispatcher] SUSPICIOUS assistant message ALLOWED through`, {
      msgType: msg.type, channel: agentId, role, kind, contentLength: trimmed.length,
      contentPreview: trimmed.substring(0, 500),
    });
  }

  // ── Streaming: update in-place ──
  if (kind === 'streaming' && role === 'assistant') {
    let existingIdx = -1;
    for (let i = ctx.messages.length - 1; i >= 0; i--) {
      if (ctx.messages[i].kind === 'streaming' && ctx.messages[i].role === 'assistant') {
        existingIdx = i;
        break;
      }
    }
    if (existingIdx !== -1) {
      ctx.messages[existingIdx] = { ...ctx.messages[existingIdx], content: finalContent };
    } else {
      ctx.messages.push({
        id: `${ Date.now() }_ws_streaming`, channelId: agentId,
        threadId: msgThreadId, role, kind, content: finalContent,
      });
    }
    return;
  }

  // ── Thinking complete: close current bubble so next thinking starts fresh ──
  if (kind === 'thinking_complete') {
    for (let i = ctx.messages.length - 1; i >= 0; i--) {
      const m = ctx.messages[i];
      if (m.kind === 'thinking' && m.role === 'assistant' && !(m as any)._completed) {
        (ctx.messages[i] as any)._completed = true;
        break;
      }
    }
    return;
  }

  // ── Thinking: accumulate into a single growing bubble ──
  if (kind === 'thinking' && role === 'assistant') {
    let existingIdx = -1;
    for (let i = ctx.messages.length - 1; i >= 0; i--) {
      const m = ctx.messages[i];
      if (m.kind === 'thinking' && m.role === 'assistant' && !(m as any)._completed) {
        existingIdx = i;
        break;
      }
    }
    if (existingIdx !== -1) {
      const existing = ctx.messages[existingIdx];
      ctx.messages[existingIdx] = { ...existing, content: existing.content + '\n\n' + finalContent };
    } else {
      ctx.messages.push({
        id: `${ Date.now() }_ws_thinking`, channelId: agentId,
        threadId: msgThreadId, role, kind: 'thinking', content: finalContent,
      });
    }
    return;
  }

  // ── Non-streaming: remove prior streaming bubble ──
  if (role === 'assistant') {
    let streamIdx = -1;
    for (let i = ctx.messages.length - 1; i >= 0; i--) {
      if (ctx.messages[i].kind === 'streaming' && ctx.messages[i].role === 'assistant') {
        streamIdx = i;
        break;
      }
    }
    if (streamIdx !== -1) {
      ctx.messages.splice(streamIdx, 1);
    }

    // Mark any open thinking bubble as completed
    for (let i = ctx.messages.length - 1; i >= 0; i--) {
      const m = ctx.messages[i];
      if (m.kind === 'thinking' && m.role === 'assistant' && !(m as any)._completed) {
        (ctx.messages[i] as any)._completed = true;
        break;
      }
    }
  }

  const message: ChatMessage = {
    id: `${ Date.now() }_ws_${ msg.type }`, channelId: agentId,
    threadId: msgThreadId, role, kind, content: finalContent,
  };

  if (kind === 'channel_message') {
    message.channelMeta = {
      senderId:      typeof data?.senderId === 'string' ? data.senderId : 'unknown',
      senderChannel: typeof data?.senderChannel === 'string' ? data.senderChannel : '',
    };
  }

  if (kind !== 'speak' && finalContent.includes('<speak>')) {
    console.warn(`[MessageDispatcher] ⚠️ LEAKED <speak> tags in non-speak message! kind=${kind}`);
  }

  console.log(`[MessageDispatcher] messages.push (structured ${ msg.type })`, {
    role: message.role, kind: message.kind, contentChars: message.content.length, content: message.content.slice(0, 120),
  });
  ctx.messages.push(message);

  if (role === 'assistant') {
    ctx.registry.setLoading(agentId, false);
  }
}

// ─── Handler: speak_dispatch ────────────────────────────────────

function handleSpeakDispatch(ctx: DispatchContext, agentId: string, msgThreadId: string, msg: WebSocketMessage): void {
  const data = (msg.data && typeof msg.data === 'object') ? (msg.data as any) : null;
  const text = typeof data?.text === 'string' ? data.text.trim() : '';
  if (!text) return;

  const pipelineSequence = typeof data?.pipelineSequence === 'number' ? data.pipelineSequence : null;

  console.log(`[MessageDispatcher] speak_dispatch → "${text.slice(0, 80)}" seq=${pipelineSequence}`);
  ctx.messages.push({
    id: `${ Date.now() }_speak`, channelId: agentId,
    threadId: msgThreadId, role: 'assistant', kind: 'speak', content: text,
  });

  for (const listener of ctx.speakListeners) {
    listener(text, msgThreadId, pipelineSequence);
  }
}

// ─── Handler: asset lifecycle ───────────────────────────────────

function handleRegisterOrActivateAsset(ctx: DispatchContext, _agentId: string, _threadId: string, msg: WebSocketMessage): void {
  const data = (msg.data && typeof msg.data === 'object') ? (msg.data as any) : null;
  if (ctx.applyAssetLifecycleUpdate(data, 'register_or_activate_asset')) return;
  console.error('[MessageDispatcher] register_or_activate_asset payload not handled', { data });
}

function handleDeactivateAsset(ctx: DispatchContext, _agentId: string, _threadId: string, msg: WebSocketMessage): void {
  const data = (msg.data && typeof msg.data === 'object') ? (msg.data as any) : null;
  const assetId = String(data?.assetId || '').trim();
  if (assetId) {
    ctx.removeAsset(assetId);
    console.log(`[MessageDispatcher] deactivate_asset: removed ${ assetId }`);
  } else {
    console.error('[MessageDispatcher] deactivate_asset: missing assetId', { data });
  }
}

// ─── Handler: progress / plan_update ────────────────────────────

function handleProgress(ctx: DispatchContext, agentId: string, msgThreadId: string, msg: WebSocketMessage): void {
  const data = (msg.data && typeof msg.data === 'object') ? (msg.data as any) : null;
  const phase = data?.phase;

  if (phase === 'tool_call') {
    const toolRunId = typeof data?.toolRunId === 'string' ? data.toolRunId : null;
    const toolName = typeof data?.toolName === 'string' ? data.toolName : 'unknown';
    const args = data?.args && typeof data.args === 'object' ? data.args : {};

    ctx.currentActivity.value = toolNameToVerb(toolName);

    // Skip chat-only tools
    if (toolName === 'emit_chat_message' || toolName === 'emit_chat_image'
      || toolName === 'load_skill') {
      return;
    }

    // Render file_search and read_file as thinking text, not tool cards
    if (toolName === 'file_search' || toolName === 'read_file') {
      let thinkingText = '';
      if (toolName === 'file_search') {
        const query = typeof args.query === 'string' ? args.query : '';
        const dir = (typeof args.dirPath === 'string' ? args.dirPath : '~').replace(/^\/Users\/[^/]+/, '~');
        thinkingText = `Searching for "${ query }" in ${ dir }`;
      } else {
        const filePath = (typeof args.path === 'string' ? args.path : typeof args.filePath === 'string' ? args.filePath : '').replace(/^\/Users\/[^/]+/, '~');
        const start = args.startLine;
        const end = args.endLine;
        const range = start ? ` (lines ${ start }${ end ? `-${ end }` : '+' })` : '';
        thinkingText = `Opening ${ filePath }${ range }`;
      }
      // Push as thinking — find or create thinking bubble
      let existingIdx = -1;
      for (let i = ctx.messages.length - 1; i >= 0; i--) {
        const m = ctx.messages[i];
        if (m.kind === 'thinking' && m.role === 'assistant' && !(m as any)._completed) {
          existingIdx = i;
          break;
        }
      }
      if (existingIdx !== -1) {
        const existing = ctx.messages[existingIdx];
        ctx.messages[existingIdx] = { ...existing, content: existing.content + '\n\n' + thinkingText };
      } else {
        ctx.messages.push({
          id: `${ Date.now() }_ws_thinking`, channelId: agentId,
          threadId: msgThreadId, role: 'assistant', kind: 'thinking', content: thinkingText,
        });
      }
      return;
    }

    if (toolRunId) {
      const messageId = `${ Date.now() }_tool_${ toolRunId }`;
      const description = typeof args?.description === 'string' ? args.description : undefined;
      const display = formatToolCard(toolName, args);
      const message: ChatMessage = {
        id: messageId, channelId: agentId, threadId: msgThreadId,
        role: 'assistant', kind: 'tool', content: '',
        toolCard: {
          toolRunId, toolName, description, status: 'running', args,
          label: display.label, summary: display.summary,
          input: display.input, outputFormat: display.outputFormat,
        },
      };
      ctx.messages.push(message);
      ctx.toolRunIdToMessageId.set(toolRunId, messageId);
    }
  }

  if (phase === 'tool_result') {
    ctx.currentActivity.value = 'Thinking';
    const toolRunId = typeof data?.toolRunId === 'string' ? data.toolRunId : null;
    const success = data?.success === true;
    const error = typeof data?.error === 'string' ? data.error : null;
    const result = data?.result;

    if (toolRunId) {
      const messageId = ctx.toolRunIdToMessageId.get(toolRunId);
      if (messageId) {
        const message = ctx.messages.find(m => m.id === messageId);
        if (message?.toolCard) {
          message.toolCard.status = success ? 'success' : 'failed';
          message.toolCard.error = error;
          message.toolCard.result = result;
          const resultDisplay = formatToolResult(
            message.toolCard.toolName,
            message.toolCard.args ?? {},
            result,
            error,
          );
          if (resultDisplay.output) message.toolCard.output = resultDisplay.output;
          if (resultDisplay.outputFormat) message.toolCard.outputFormat = resultDisplay.outputFormat;
        }
        ctx.toolRunIdToMessageId.delete(toolRunId);
      }
    }
  }
}

// ─── Handler: chat_image ────────────────────────────────────────

function handleChatImage(ctx: DispatchContext, agentId: string, msgThreadId: string, msg: WebSocketMessage): void {
  const data = (msg.data && typeof msg.data === 'object') ? (msg.data as any) : null;
  const src = typeof data?.src === 'string' ? data.src : '';
  const alt = typeof data?.alt === 'string' ? data.alt : '';
  const path = typeof data?.path === 'string' ? data.path : '';
  if (!src) {
    console.log('[MessageDispatcher] Skipping chat_image - empty src');
    return;
  }

  const roleRaw = data?.role !== undefined ? String(data.role) : 'assistant';
  const role = (roleRaw === 'user' || roleRaw === 'assistant' || roleRaw === 'system' || roleRaw === 'error')
    ? roleRaw : 'assistant';

  ctx.messages.push({
    id: `${ Date.now() }_ws_chat_image`, channelId: agentId,
    threadId: msgThreadId, role, content: '',
    image: { dataUrl: src, alt, path },
  });
  console.log('[MessageDispatcher] Chat image stored. src:', src.substring(0, 80));

  if (role === 'assistant') {
    ctx.registry.setLoading(agentId, false);
  }
}

// ─── Handler: transfer_data ─────────────────────────────────────

function handleTransferData(ctx: DispatchContext, agentId: string, _threadId: string, msg: WebSocketMessage): void {
  const data = (msg.data && typeof msg.data === 'object') ? (msg.data as any) : null;
  if (data === 'graph_execution_complete' || data?.content === 'graph_execution_complete') {
    const reason = data?.stopReason || null;
    const waiting = !!(data?.waitingForUser);
    console.log('[MessageDispatcher] Graph execution complete, stopReason:', reason, 'waitingForUser:', waiting);
    ctx.graphRunning.value = false;
    ctx.waitingForUser.value = waiting;
    ctx.stopReason.value = reason;
    ctx.registry.setLoading(agentId, false);
  }
}

// ─── Handler: thread_created ────────────────────────────────────

function handleThreadCreated(ctx: DispatchContext, _agentId: string, _threadId: string, msg: WebSocketMessage): void {
  const data = (msg.data && typeof msg.data === 'object') ? (msg.data as any) : {};
  const threadId = data.threadId;
  if (threadId && typeof threadId === 'string') {
    ctx.setThreadId(threadId);
  }
}

// ─── Handler: thread_restored ───────────────────────────────────

function handleThreadRestored(ctx: DispatchContext, agentId: string, msgThreadId: string, msg: WebSocketMessage): void {
  const data = (msg.data && typeof msg.data === 'object') ? (msg.data as any) : {};
  const restoredMessages = Array.isArray(data.messages) ? data.messages : [];

  if (restoredMessages.length > 0 && ctx.messages.length === 0) {
    console.log(`[MessageDispatcher] Restoring ${ restoredMessages.length } messages from thread ${ data.threadId }`);
    for (const m of restoredMessages) {
      if ((m.metadata as any)?._conversationSummary) continue;
      const role = m.role === 'user' ? 'user' : 'assistant';
      const content = typeof m.content === 'string' ? m.content : '';
      if (!content.trim()) continue;
      ctx.messages.push({
        id:        m.id || `restored_${ Date.now() }_${ Math.random().toString(36).slice(2, 6) }`,
        channelId: agentId,
        threadId:  msgThreadId,
        role,
        content,
        ...(typeof m.kind === 'string' && m.kind ? { kind: m.kind } : {}),
      });
    }
  }
}

// ─── Handler: token_info ────────────────────────────────────────

function handleTokenInfo(ctx: DispatchContext, _agentId: string, _threadId: string, msg: WebSocketMessage): void {
  const data = (msg.data && typeof msg.data === 'object') ? (msg.data as any) : {};
  if (typeof data.tokens_used === 'number') {
    ctx.handleTokenInfo(
      data.tokens_used, data.prompt_tokens, data.completion_tokens,
      data.time_spent, data.threadId, data.nodeId,
    );
  }
}

// ─── Handler: workflow_execution_event ──────────────────────────

function handleWorkflowExecutionEvent(ctx: DispatchContext, agentId: string, msgThreadId: string, msg: WebSocketMessage): void {
  const data = (msg.data && typeof msg.data === 'object') ? (msg.data as any) : null;
  if (!data) return;
  console.log(`[MessageDispatcher] workflow_execution_event — type="${ data.type }", nodeId="${ data.nodeId || '' }"`);

  const eventType: string = data.type || '';
  const nodeId: string = data.nodeId || '';
  const nodeLabel: string = data.nodeLabel || '';
  const workflowRunId: string = data.thread_id || `wf_${ Date.now() }`;
  const totalNodes: number = typeof data.totalNodes === 'number' ? data.totalNodes : 0;
  const nodeIndex: number = typeof data.nodeIndex === 'number' ? data.nodeIndex : 0;

  if (eventType === 'workflow_started') {
    ctx.messages.push({
      id: `${ Date.now() }_wf_started`, channelId: agentId,
      threadId: msgThreadId, role: 'assistant', kind: 'workflow_node', content: '',
      workflowNode: {
        workflowRunId, nodeId: '', nodeLabel: 'Workflow Started',
        status: 'running', nodeIndex: 0, totalNodes,
      },
    });
    return;
  }

  if (eventType === 'node_started') {
    ctx.messages.push({
      id: `${ Date.now() }_wf_node_${ nodeId }`, channelId: agentId,
      threadId: msgThreadId, role: 'assistant', kind: 'workflow_node', content: '',
      workflowNode: {
        workflowRunId, nodeId, nodeLabel, status: 'running',
        prompt: typeof data.prompt === 'string' ? data.prompt : undefined,
        nodeIndex, totalNodes,
      },
    });
    return;
  }

  if (eventType === 'node_completed' || eventType === 'node_failed' || eventType === 'node_waiting') {
    const existing = [...ctx.messages].reverse().find(
      m => m.workflowNode?.nodeId === nodeId && m.workflowNode?.status === 'running',
    );
    if (existing?.workflowNode) {
      existing.workflowNode.status = eventType === 'node_completed' ? 'completed'
        : eventType === 'node_failed' ? 'failed' : 'waiting';
      if (data.output !== undefined) {
        existing.workflowNode.output = typeof data.output === 'string'
          ? data.output : JSON.stringify(data.output);
      }
      if (data.error) existing.workflowNode.error = String(data.error);
      if (totalNodes > 0) existing.workflowNode.totalNodes = totalNodes;
      if (nodeIndex > 0) existing.workflowNode.nodeIndex = nodeIndex;
    }
    return;
  }

  if (eventType === 'workflow_completed' || eventType === 'workflow_failed') {
    const startCard = [...ctx.messages].reverse().find(
      m => m.workflowNode?.nodeLabel === 'Workflow Started' && m.workflowNode?.status === 'running',
    );
    if (startCard?.workflowNode) {
      startCard.workflowNode.status = eventType === 'workflow_completed' ? 'completed' : 'failed';
      if (data.error) startCard.workflowNode.error = String(data.error);
    }
  }

  if (eventType === 'node_thinking') {
    const thinkingContent = typeof data.content === 'string' ? data.content : '';
    if (!thinkingContent || !nodeId) return;

    // Streaming tokens arrive as accumulated content (not deltas).
    // Replace the last line instead of pushing a duplicate.
    const isStreaming = data.kind === 'streaming';

    const existing = [...ctx.messages].reverse().find(
      m => m.subAgentActivity?.nodeId === nodeId && m.subAgentActivity?.status === 'running',
    );
    if (existing?.subAgentActivity) {
      if (isStreaming && existing.subAgentActivity.thinkingLines.length > 0) {
        // Replace last line — streaming sends the full accumulated text each time
        existing.subAgentActivity.thinkingLines[existing.subAgentActivity.thinkingLines.length - 1] = thinkingContent;
      } else {
        existing.subAgentActivity.thinkingLines.push(thinkingContent);
      }
      existing.subAgentActivity.latestThinking = thinkingContent;
    } else {
      ctx.messages.push({
        id: `${ Date.now() }_sub_agent_${ nodeId }`, channelId: agentId,
        threadId: msgThreadId, role: 'assistant', kind: 'sub_agent_activity', content: '',
        subAgentActivity: {
          nodeId, nodeLabel: nodeLabel || nodeId, status: 'running',
          thinkingLines: [thinkingContent], latestThinking: thinkingContent,
        },
      });
    }
    return;
  }

  if (eventType === 'sub_agent_blocked') {
    const existing = [...ctx.messages].reverse().find(
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

  if (eventType === 'sub_agent_completed' || eventType === 'sub_agent_failed') {
    const existing = [...ctx.messages].reverse().find(
      m => m.subAgentActivity?.nodeId === nodeId &&
           (m.subAgentActivity?.status === 'running' || m.subAgentActivity?.status === 'blocked'),
    );
    if (existing?.subAgentActivity) {
      existing.subAgentActivity.status = eventType === 'sub_agent_completed' ? 'completed' : 'failed';
      if (data.output !== undefined) {
        existing.subAgentActivity.output = typeof data.output === 'string'
          ? data.output : JSON.stringify(data.output);
      }
      if (data.error) existing.subAgentActivity.error = String(data.error);
    }
    return;
  }

  // edge_activated and other sub-events are visual-only (canvas), skip chat
}

// ─── Protocol no-ops ────────────────────────────────────────────

function handleNoop(): void { /* protocol-level — nothing to do */ }

// ─── Helper (moved from AgentPersonaModel module scope) ─────────

const TOOL_VERB_MAP: Record<string, string> = {
  // Execution
  exec: 'Running', exec_command: 'Running', shell: 'Running', bash: 'Running', run_command: 'Running',
  // Search
  file_search: 'Searching',
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

// ─── Factory ────────────────────────────────────────────────────

/**
 * Creates a MessageDispatcher with all standard handlers registered.
 */
export function createMessageDispatcher(): MessageDispatcher {
  const dispatcher = new MessageDispatcher();

  // Chat messages (4 aliases)
  dispatcher.register('chat_message',     handleChatMessage);
  dispatcher.register('assistant_message', handleChatMessage);
  dispatcher.register('user_message',     handleChatMessage);
  dispatcher.register('system_message',   handleChatMessage);

  // Speak
  dispatcher.register('speak_dispatch',   handleSpeakDispatch);

  // Assets
  dispatcher.register('register_or_activate_asset', handleRegisterOrActivateAsset);
  dispatcher.register('deactivate_asset', handleDeactivateAsset);

  // Progress / tools
  dispatcher.register('progress',         handleProgress);
  dispatcher.register('plan_update',      handleProgress);

  // Media
  dispatcher.register('chat_image',       handleChatImage);

  // State
  dispatcher.register('transfer_data',    handleTransferData);
  dispatcher.register('thread_created',   handleThreadCreated);
  dispatcher.register('thread_restored',  handleThreadRestored);
  dispatcher.register('token_info',       handleTokenInfo);

  // Workflow
  dispatcher.register('workflow_execution_event', handleWorkflowExecutionEvent);

  // Protocol no-ops
  dispatcher.register('ack',       handleNoop);
  dispatcher.register('ping',      handleNoop);
  dispatcher.register('pong',      handleNoop);
  dispatcher.register('subscribe', handleNoop);
  dispatcher.register('stop_run',  handleNoop);

  return dispatcher;
}

// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

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

import type { WebSocketMessage } from '@pkg/agent/services/WebSocketClientService';
import { formatToolCard, formatToolResult, TOOL_PAYLOAD_POINTER_THRESHOLD } from '@pkg/agent/tools/toolCardFormatters';
import { ToolResultCardProjector } from './ToolResultCardProjector';
import { dispatchLogger as console } from '@pkg/agent/utils/agentLogger';
import { stripProtocolTagsForUi, stripProtocolTagsStreaming } from '@pkg/agent/utils/stripProtocolTags';
import { isTerminalRunError } from '@pkg/agent/workflow/agentNodeError';
import { AgentReadinessStatus } from '@pkg/shared/agentReadinessStatus';
import { readAgentResultCard } from '@pkg/shared/agentResults/AgentResultCard';

import type { ChatMessage, AgentPersonaRegistry } from '../registry/AgentPersonaRegistry';
import type { Ref } from 'vue';

const MAX_THINKING_CHARS    = 10_000;

function capText(s: string, max: number): string {
  return s.length <= max ? s : s.slice(s.length - max);
}

function uniqueMessageId(ctx: DispatchContext, baseId: string): string {
  let id = baseId;
  for (let n = 1; ctx.messages.some(message => message.id === id); n++) id = `${ baseId }_${ n }`;
  return id;
}

function appendThinkingMessage(ctx: DispatchContext, agentId: string, msgThreadId: string, content: string, reportingActivity?: 'status' | 'tool'): void {
  const last = ctx.messages[ctx.messages.length - 1] as (ChatMessage & { _completed?: boolean }) | undefined;
  // Only adjacent events in the same open segment may share a source
  // record. Otherwise a later status can jump ahead of a decision or evidence.
  if (!reportingActivity && !last?.reportingActivity && !last?.chatToolActivity && last?.kind === 'thinking' && last.role === 'assistant' && last.channelId === agentId
    && last.threadId === msgThreadId && !last._completed) {
    ctx.messages[ctx.messages.length - 1] = {
      ...last,
      content: capText(last.content + '\n\n' + content, MAX_THINKING_CHARS),
    };
    return;
  }

  const id = uniqueMessageId(ctx, `${ Date.now() }_ws_thinking`);
  ctx.messages.push({ id, channelId: agentId, threadId: msgThreadId, role: 'assistant', kind: 'thinking', content, reportingActivity });
}

function contentToString(content: any): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content ?? '');
  return content.map((b: any) => {
    if (typeof b === 'string') return b;
    if (b?.type === 'text' && typeof b.text === 'string') return b.text;
    if (b?.type === 'tool_result') {
      if (typeof b.content === 'string') return b.content;
      if (Array.isArray(b.content)) return b.content.map((c: any) => (typeof c === 'string' ? c : (c?.text ?? ''))).filter(Boolean).join('\n');
    }
    return '';
  }).filter(Boolean).join('\n');
}

// ─── Types ──────────────────────────────────────────────────────

export type SpeakListener = (text: string, threadId: string, pipelineSequence: number | null, voiceTurnId: string | null) => void;

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
  getThreadId(): string | undefined;
  handleTokenInfo(
    tokens_used: number,
    prompt_tokens: number,
    completion_tokens: number,
    time_spent: number,
    threadId?: string,
    nodeId?: string,
  ): void;
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
      const data = msg.data as any;
      if (data?.modelStatus && typeof data.modelStatus.model === 'string' && !data.readinessWaitId) {
        for (let index = ctx.messages.length - 1; index >= 0; index--) {
          const message = ctx.messages[index];
          if (message.channelId === agentId && message.threadId === threadId) { message.modelStatus = data.modelStatus; break }
        }
      }
    } else {
      console.log('[MessageDispatcher] Unhandled message type:', msg.type);
    }
  }
}

// ─── Handler: chat / assistant / system messages ────────────────

function handleChatMessage(ctx: DispatchContext, agentId: string, msgThreadId: string, msg: WebSocketMessage): void {
  if (msg.data && typeof msg.data === 'object' && AgentReadinessStatus.apply(ctx.messages, agentId, msgThreadId, msg.data as Record<string, unknown>)) return;
  const activity = msg.data as { kind?: string; thread_id?: string; chatToolActivity?: ChatMessage['chatToolActivity'] } | null;
  const inline = msg.data && typeof msg.data === 'object' ? (msg.data as any).inlineFileReference : undefined;
  if ((msg.data as any)?.kind === 'inline_file_reference') {
    const reference = inline?.reference;
    const inlineThreadId = inline?.thread_id;
    const toolCallId = inline?.tool_call_id;
    const fileId = reference?.file_id;
    const collectionId = reference?.collection_id;
    if (msg.type !== 'assistant_message' || !msgThreadId || !inline || inlineThreadId !== msgThreadId ||
      ![fileId, collectionId, toolCallId, inlineThreadId].every((value: unknown) => typeof value === 'string' && value.trim().length > 0)) return;
    const id = `inline-file:${agentId}:${msgThreadId}:${toolCallId}`;
    if (ctx.messages.some(message => message.id === id)) return;
    ctx.messages.push({
      id, channelId: agentId, threadId: msgThreadId, role: 'assistant', content: '',
      kind: 'inline_file_reference', inlineFileReference: {
        file_id: fileId, collection_id: collectionId,
        tool_call_id: toolCallId, thread_id: inlineThreadId,
      },
    });
    return;
  }
  if (activity?.kind === 'chat_tool_activity') {
    if (msg.type !== 'assistant_message' || !msgThreadId || activity.thread_id !== msgThreadId ||
      typeof activity.chatToolActivity !== 'string') return;
    // IPC assigns an id and timestamp once per emitted event, not per
    // dispatch. Keep that identity in the saved message id, scoped to the
    // originating chat. Never collapse distinct events by their display text.
    const id = msg.id
      ? `${ msg.timestamp }_ws_chat_tool_activity_${ encodeURIComponent(JSON.stringify([agentId, msgThreadId, msg.id])) }`
      : uniqueMessageId(ctx, `${ Date.now() }_ws_chat_tool_activity`);
    if (ctx.messages.some(message => message.id === id)) return;
    const record: ChatMessage & { _completed: boolean } = {
      id,
      channelId: agentId, threadId: msgThreadId, role: 'assistant', kind: 'thinking', content: '',
      chatToolActivity: activity.chatToolActivity,
      _completed: true,
    };
    ctx.messages.push(record);
    return;
  }
  // Only the primary orchestration loop's emissions affect run-state.
  // Subconscious agents emit on the `subconscious_message` wire type
  // (see SubconsciousAgentNode + BaseNode.wsChatMessage's messageType
  // param) — those still flow through this handler for bubble rendering
  // but must not flip graphRunning, otherwise stop button visibility
  // gets driven by background activity instead of the user's own loop.
  const terminalRunError = isTerminalRunError(msg);
  if (msg.type !== 'subconscious_message' && (msg.data as { kind?: string } | null)?.kind !== 'citation') {
    ctx.graphRunning.value = !terminalRunError;
    if (!ctx.graphRunning.value) ctx.registry.setLoading(agentId, false);
  }

  // user_message: already pushed locally before send — skip
  if (msg.type === 'user_message') return;

  // ── String payload (simple content) ──
  if (typeof msg.data === 'string') {
    const text = msg.type !== 'system_message' && /^\s*<AGENT_DONE>/i.test(msg.data) ? stripProtocolTagsForUi(msg.data) : msg.data;
    if (!text.trim()) {
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
      id:        uniqueMessageId(ctx, `${ Date.now() }_ws_${ msg.type }`),
      channelId: agentId,
      threadId:  msgThreadId,
      role:      msg.type === 'system_message' ? 'system' : 'assistant',
      content:   text,
      ...(terminalRunError ? { terminalRunError } : {}),
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

  const kindRaw = typeof data.kind === 'string' ? data.kind : undefined;
  const replyStreamId = msg.type === 'assistant_message' && typeof data.replyStreamId === 'string'
    ? data.replyStreamId : undefined;
  const agentReporting = (msg.type === 'assistant_message' || msg.type === 'subconscious_message' || msg.type === 'chat_message') &&
    (data.role === undefined || data.role === 'assistant') &&
    (data.agentReporting === 'brief' || data.agentReporting === 'standard')
    ? data.agentReporting as ChatMessage['agentReporting'] : undefined;
  const rawContent = data?.content !== undefined ? contentToString(data.content) : '';
  const doneWrapper = msg.type !== 'system_message' && (!data.role || data.role === 'assistant')
    && (!data.kind || data.kind === 'streaming' || data.kind === 'text') && /^\s*<AGENT_DONE>/i.test(rawContent);
  const content = doneWrapper
    ? (kindRaw === 'streaming' ? stripProtocolTagsStreaming(rawContent) : stripProtocolTagsForUi(rawContent))
    : rawContent;

  // Segment-boundary sentinels: kind carries the meaning, content is empty
  // by design. Must be handled BEFORE the empty-content drop or the signal
  // gets swallowed and the streaming/thinking bubbles never close.
  if (kindRaw === 'streaming_complete' || kindRaw === 'thinking_complete') {
    const target = kindRaw === 'streaming_complete' ? 'streaming' : 'thinking';
    if (target === 'streaming' && replyStreamId) {
      const reportedModel = typeof data.reportedModel === 'string' ? data.reportedModel.trim() : '';
      // Only the segment being closed gets the producer's intent. Model attribution still
      // updates all segments of this stream without reclassifying earlier narration.
      const closing = agentReporting ? ctx.messages.findLast(message =>
        message.kind === 'streaming' && message.channelId === agentId && message.threadId === msgThreadId &&
        message.replyStreamId === replyStreamId && !(message as ChatMessage & { _completed?: boolean })._completed) : undefined;
      if (closing) closing.agentReporting = agentReporting;
      for (const message of ctx.messages) {
        if (message.kind !== 'streaming' || message.channelId !== agentId || message.threadId !== msgThreadId ||
          message.replyStreamId !== replyStreamId) continue;
        (message as ChatMessage & { _completed?: boolean })._completed = true;
        if (reportedModel) message.replyAttribution = { ...message.replyAttribution, model: reportedModel };
      }
      return;
    }
    for (let i = ctx.messages.length - 1; i >= 0; i--) {
      const m = ctx.messages[i];
      if (m.kind === target && m.role === 'assistant' && m.threadId === msgThreadId && !(m as any)._completed &&
        (target !== 'streaming' || m.decisionFollowUpId === data?.decisionFollowUpId)) {
        if (target === 'thinking') {
          console.log(`[ThinkingTrace] CLOSED thinking bubble id=${ m.id } reason=sentinel:${ kindRaw } (channel=${ agentId }, msgThreadId=${ msgThreadId }, bubbleThreadId=${ m.threadId })`);
        }
        (ctx.messages[i] as any)._completed = true;
        break;
      }
    }
    return;
  }

  // Citation cards: the model emitted a <citations> block. Content is empty
  // by design — the renderer draws a card grid from the `citations` array
  // on the message. Dropped silently if the payload is missing/malformed.
  if (kindRaw === 'citation') {
    const rawSources = Array.isArray(data?.citations) ? data.citations : [];
    const citations = rawSources
      .map((s: unknown) => {
        if (!s || typeof s !== 'object') return null;
        const r = s as Record<string, unknown>;
        const title = typeof r.title === 'string' ? r.title.trim() : '';
        const origin = typeof r.origin === 'string' ? r.origin.trim() : '';
        if (!title || !origin) return null;
        const numRaw = r.num;
        const num = typeof numRaw === 'number' && Number.isFinite(numRaw)
          ? numRaw
          : Number.parseInt(String(numRaw ?? ''), 10);
        const url = typeof r.url === 'string' && r.url.trim().length > 0 ? r.url.trim() : undefined;
        return { num: Number.isFinite(num) ? num : 0, title, origin, url };
      })
      .filter(Boolean) as { num: number; title: string; origin: string; url?: string }[];

    if (citations.length === 0) return;

    // Replays of the same structured event keep its original message ID.
    // Distinct replies are allowed to cite the same documents again.
    const id = typeof data.citationId === 'string' && /^\d{13}_ws_citation_[a-f0-9-]{36}$/.test(data.citationId)
      ? data.citationId : uniqueMessageId(ctx, `${ Date.now() }_ws_citation`);
    if (ctx.messages.some(message => message.id === id)) return;
    ctx.messages.push({
      id,
      channelId: agentId,
      threadId:  msgThreadId,
      role:      'assistant',
      kind:      'citation',
      content:   '',
      citations,
    });
    return;
  }

  // Tool approval: a backend tool parked a pending approval via
  // ApprovalService and emitted this message so the user can decide.
  // Content is empty by design — the reason/command live on `toolApproval`.
  // When the user clicks approve/deny in the transcript, the renderer
  // fires the `approval:resolve` IPC back to main, which settles the
  // pending promise the tool is awaiting.
  if (kindRaw === 'tool_approval') {
    const ta = data?.toolApproval && typeof data.toolApproval === 'object' ? data.toolApproval as any : null;
    const approvalId = typeof ta?.approvalId === 'string' ? ta.approvalId.trim() : '';
    const reason = typeof ta?.reason === 'string' ? ta.reason.trim() : '';
    const command = typeof ta?.command === 'string' ? ta.command.trim() : '';
    if (!approvalId || !reason || !command) return;
    if (ctx.messages.some(message => message.kind === 'tool_approval' && message.threadId === msgThreadId &&
      message.toolApproval?.approvalId === approvalId)) return;
    const title = typeof ta?.title === 'string' && ta.title.trim() ? ta.title.trim() : undefined;
    const expiresAt = typeof ta?.expiresAt === 'number' && Number.isFinite(ta.expiresAt) ? ta.expiresAt : undefined;

    ctx.messages.push({
      id:        `${ Number.isFinite(data?.timestamp) ? data.timestamp : Date.now() }_ws_tool_approval_${ approvalId }`,
      channelId: agentId,
      threadId:  msgThreadId,
      role:      'assistant',
      kind:      'tool_approval',
      content:   '',
      toolApproval: {
        approvalId,
        reason,
        command,
        ...(title ? { title } : {}),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        origin: ta?.origin && typeof ta.origin === 'object' ? ta.origin : undefined,
      },
    });
    return;
  }

  // Tool question: a backend tool (in-process `ask_user_question` or the
  // MCP `ask_user_question`) parked a pending question via ApprovalService
  // and emitted this message so the user can choose. Content is empty by
  // design — the questions live on `toolQuestion`. When the user answers in
  // the transcript, the renderer fires the `question:resolve` IPC back to
  // main, which settles the pending promise the tool is awaiting.
  if (kindRaw === 'tool_question') {
    const tq = data?.toolQuestion && typeof data.toolQuestion === 'object' ? data.toolQuestion as any : null;
    const questionId = typeof tq?.questionId === 'string' ? tq.questionId.trim() : '';
    const rawQuestions = Array.isArray(tq?.questions) ? tq.questions : [];
    const questions = rawQuestions.map((q: any) => ({
      question:    typeof q?.question === 'string' ? q.question : '',
      header:      typeof q?.header === 'string' ? q.header : undefined,
      multiSelect: q?.multiSelect === true,
      task:        q?.task === true || undefined,
      command:     q?.task === true && typeof q?.command === 'string' ? q.command : undefined,
      options:     Array.isArray(q?.options)
        ? q.options.map((o: any) => ({
          label:       typeof o?.label === 'string' ? o.label : '',
          description: typeof o?.description === 'string' ? o.description : undefined,
        })).filter((o: any) => o.label)
        : [],
    })).filter((q: any) => q.question && q.options.length > 0);
    if (!questionId || questions.length === 0) return;

    ctx.messages.push({
      id:        `${ Date.now() }_ws_tool_question_${ questionId }`,
      channelId: agentId,
      threadId:  msgThreadId,
      role:      'assistant',
      kind:      'tool_question',
      content:   '',
      toolQuestion: { questionId, questions },
    });
    return;
  }

  // Proactive card: a backend emitter (workflow completion, sub-agent
  // async completion, heartbeat insight) is reaching out unprompted to
  // the user. Content carries the body; `data.headline` carries the
  // short title. Rendered as a ProactiveCard in the new chat UI.
  if (kindRaw === 'proactive') {
    const headline = typeof data?.headline === 'string' ? data.headline.trim() : '';
    const body = typeof data?.body === 'string'
      ? data.body.trim()
      : (typeof data?.content === 'string' ? data.content.trim() : '');
    if (!headline && !body) return;
    const result = readAgentResultCard(data?.result);

    ctx.messages.push({
      id:        uniqueMessageId(ctx, `${ Date.now() }_ws_proactive`),
      channelId: agentId,
      threadId:  msgThreadId,
      role:      'assistant',
      kind:      'proactive',
      content:   body,
      ...(agentReporting ? { agentReporting } : {}),
      proactive: { headline: headline || 'Sulla', body, ...(result ? { result } : {}) },
    });
    return;
  }

  // UI-only parent ↔ sub-agent exchange. This arrives as chat_message so it
  // persists with the transcript, but it is never added to graph state.
  if (kindRaw === 'sub_agent_exchange') {
    const exchange = data?.subAgentExchange && typeof data.subAgentExchange === 'object'
      ? data.subAgentExchange
      : null;
    if (!exchange || !['to_agent', 'from_agent'].includes(exchange.direction)) return;

    ctx.messages.push({
      id:        `${ Date.now() }_ws_sub_agent_exchange_${ exchange.jobId || exchange.taskIndex || '' }`,
      channelId: agentId,
      threadId:  msgThreadId,
      role:      'assistant',
      kind:      'sub_agent_exchange',
      content:   String(exchange.summary ?? ''),
      subAgentExchange: {
        direction: exchange.direction,
        agentId: String(exchange.agentId ?? 'sub-agent'),
        label: String(exchange.label ?? exchange.agentId ?? 'Sub-agent'),
        summary: String(exchange.summary ?? ''),
        detail: String(exchange.detail ?? ''),
        status: ['running', 'done', 'failed', 'stopped'].includes(exchange.status) ? exchange.status : 'running',
        jobId: typeof exchange.jobId === 'string' ? exchange.jobId : undefined,
        taskIndex: typeof exchange.taskIndex === 'number' ? exchange.taskIndex : undefined,
        conversationId: typeof exchange.conversationId === 'string' ? exchange.conversationId : undefined,
        native: exchange.native === true,
      },
    });
    return;
  }

  // File patch: ClaudeCodeService → BaseNode.onFilePatch emitted a unified
  // diff after an Edit/Write tool_use inside Claude's inner agent loop.
  // Content is empty by design — payload is on `data.filePatch`. PersonaAdapter
  // maps this into a `kind:'patch'` message for the new chat's PatchBlock.vue.
  if (kindRaw === 'file_patch') {
    const fp = data?.filePatch && typeof data.filePatch === 'object' ? data.filePatch as any : null;
    if (!fp || typeof fp.path !== 'string' || !Array.isArray(fp.hunks)) return;

    ctx.messages.push({
      id:        `${ Date.now() }_ws_file_patch`,
      channelId: agentId,
      threadId:  msgThreadId,
      role:      'assistant',
      kind:      'file_patch',
      content:   '',
      filePatch: {
        path:       String(fp.path),
        stat:       {
          added:   Number(fp.stat?.added ?? 0),
          removed: Number(fp.stat?.removed ?? 0),
        },
        hunks:      fp.hunks.map((h: any) => ({
          lines: Array.isArray(h?.lines) ? h.lines.map((l: any) => ({
            n:    Number(l?.n ?? 0),
            text: typeof l?.text === 'string' ? l.text : '',
            op:   (l?.op === 'add' || l?.op === 'remove') ? l.op : 'context',
          })) : [],
        })),
        revertMeta: fp.revertMeta && typeof fp.revertMeta === 'object' ? fp.revertMeta : undefined,
      },
    });
    return;
  }

  // Workflow document: the `workflow/display` tool published a routine
  // for the artifact sidebar. Content is empty by design — the payload
  // is the full routine doc under `data.workflow`. PersonaAdapter opens
  // or updates a workflow artifact keyed by slug so repeat emits (after
  // each import_workflow) update the same sidebar card in place.
  if (kindRaw === 'workflow_document') {
    const doc = data?.workflow && typeof data.workflow === 'object' ? (data.workflow as any) : null;
    if (!doc || typeof doc.slug !== 'string' || !doc.slug.trim()) return;
    const nodes = Array.isArray(doc.nodes) ? doc.nodes : [];
    const edges = Array.isArray(doc.edges) ? doc.edges : [];

    ctx.messages.push({
      id:        `${ Date.now() }_ws_workflow_document_${ doc.slug }`,
      channelId: agentId,
      threadId:  msgThreadId,
      role:      'assistant',
      kind:      'workflow_document',
      content:   '',
      workflowDocument: {
        slug:        String(doc.slug),
        id:          typeof doc.id === 'string' ? doc.id : undefined,
        name:        typeof doc.name === 'string' ? doc.name : undefined,
        description: typeof doc.description === 'string' ? doc.description : undefined,
        _status:     doc._status === 'draft' || doc._status === 'production' || doc._status === 'archive' ? doc._status : undefined,
        viewport:    doc.viewport && typeof doc.viewport === 'object' ? doc.viewport : undefined,
        nodes,
        edges,
      },
    });
    return;
  }

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
  const kind = (typeof data?.kind === 'string') ? data.kind : undefined;
  const finalContent = content;
  // Inline links are parsed for rendering, not recorded as attachment intent.
  const rawReferences: ChatMessage['fileReferences'] = Array.isArray(data?.fileReferences) ? data.fileReferences
    : Array.isArray(data?.metadata?.fileReferences) ? data.metadata.fileReferences : undefined;
  const explicitReferences = rawReferences?.filter((item, index, values) =>
    typeof item?.fileId === 'string' && !!item.fileId && values.findIndex(candidate => candidate?.fileId === item.fileId && candidate?.versionId === item.versionId) === index);
  const referenceUpdate = explicitReferences?.length ? { fileReferences: explicitReferences } : {};
  const decisionFollowUpId = msg.type === 'assistant_message' && role === 'assistant' &&
    (kind === 'streaming' || kind === 'text' || !kind) && typeof data?.decisionFollowUpId === 'string'
    ? data.decisionFollowUpId : undefined;

  const attribution = data?.replyAttribution;
  const agent = typeof attribution?.agent === 'string' ? attribution.agent.trim() : '';
  const model = typeof attribution?.model === 'string' ? attribution.model.trim() : '';
  const replyAttribution = msg.type === 'assistant_message' && role === 'assistant' &&
    (kind === 'streaming' || kind === 'text' || !kind) && (agent || model)
    ? { agent: agent || undefined, model: model || undefined } : undefined;
  const belongsToReply = (message: ChatMessage) => message.channelId === agentId &&
    message.decisionFollowUpId === decisionFollowUpId &&
    message.agentReporting === agentReporting &&
    (kind !== 'streaming' || message.replyStreamId === replyStreamId) &&
    message.replyAttribution?.agent === replyAttribution?.agent && message.replyAttribution?.model === replyAttribution?.model;

  if (kind === 'speak') {
    console.log(`[MessageDispatcher] SPEAK received → channel="${ agentId }", thread="${ msgThreadId }", content="${ content.slice(0, 80) }"`);
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
      msgType:        msg.type,
      channel:        agentId,
      role,
      kind,
      contentLength:  trimmed.length,
      contentPreview: trimmed.substring(0, 500),
    });
  }

  const replyBoundary = (message: ChatMessage) => message.role === 'user' || message.kind === 'tool_approval' ||
    message.kind === 'tool_question' || (message.threadId && message.threadId !== msgThreadId);

  // ── Streaming: update in-place, but respect segment boundaries ──
  if (kind === 'streaming' && role === 'assistant') {
    // Streaming chunks carry the FULL accumulated text-so-far, not deltas.
    // First preference: an open streaming bubble — replace its content.
    let existingIdx = -1;
    for (let i = ctx.messages.length - 1; i >= 0; i--) {
      const m = ctx.messages[i];
      if (replyBoundary(m)) break;
      if (m.kind === 'streaming' && m.role === 'assistant' && m.threadId === msgThreadId && belongsToReply(m) && !(m as any)._completed) {
        existingIdx = i;
        break;
      }
    }
    if (existingIdx !== -1) {
      ctx.messages[existingIdx] = { ...ctx.messages[existingIdx], content: finalContent, ...referenceUpdate };
      return;
    }

    // No open bubble. Before creating a new one, check whether this chunk is
    // a continuation of a previously-sealed streaming bubble in the same turn
    // (i.e. tool_call/thinking interjected mid-stream and sealed the bubble,
    // and the next chunk arrived carrying the same prefix plus more text).
    // Resurrect that bubble in place so the response keeps growing where the
    // user was already reading it, instead of creating a duplicate below.
    const trimmedIncoming = finalContent.trim();
    let resurrectedIdx = -1;
    for (let i = ctx.messages.length - 1; i >= 0; i--) {
      const m = ctx.messages[i];
      if (replyBoundary(m)) break;
      if (m.role !== 'assistant') continue;
      if (m.kind !== 'streaming' || m.threadId !== msgThreadId || !belongsToReply(m)) continue;
      const prev = (m.content || '').trim();
      if (!prev) continue;
      if (trimmedIncoming.startsWith(prev) || prev.startsWith(trimmedIncoming)) {
        resurrectedIdx = i;
        break;
      }
    }
    if (resurrectedIdx !== -1) {
      const existing = ctx.messages[resurrectedIdx];
      ctx.messages[resurrectedIdx] = { ...existing, content: finalContent, ...referenceUpdate };
      (ctx.messages[resurrectedIdx] as any)._completed = false;
      return;
    }

    // Fresh streaming segment with no prefix relationship to any prior bubble
    // — collapse any open thinking bubble and start a new one.
    for (let i = ctx.messages.length - 1; i >= 0; i--) {
      const m = ctx.messages[i];
      if (m.kind === 'thinking' && m.role === 'assistant' && !(m as any)._completed) {
        console.log(`[ThinkingTrace] CLOSED thinking bubble id=${ m.id } reason=streaming_arrival (channel=${ agentId }, msgThreadId=${ msgThreadId }, bubbleThreadId=${ m.threadId })`);
        (ctx.messages[i] as any)._completed = true;
        break;
      }
    }
    const id = uniqueMessageId(ctx, `${ Date.now() }_ws_streaming`);
    ctx.messages.push({
      id,
      channelId: agentId,
      threadId:  msgThreadId,
      role,
      kind,
      content:   finalContent,
      ...(agentReporting ? { agentReporting } : {}),
      ...(decisionFollowUpId ? { decisionFollowUpId } : {}),
      ...(replyAttribution ? { replyAttribution } : {}),
      ...(replyStreamId ? { replyStreamId } : {}),
      ...referenceUpdate,
    });
    return;
  }

  // ── Streaming complete: close current streaming bubble so the next
  //    streaming token starts a fresh bubble. Fired when the model
  //    transitions from text output to thinking/tool_use.              ──
  if (kind === 'streaming_complete') {
    for (let i = ctx.messages.length - 1; i >= 0; i--) {
      const m = ctx.messages[i];
      if (m.kind === 'streaming' && m.role === 'assistant' && !(m as any)._completed) {
        (ctx.messages[i] as any)._completed = true;
        break;
      }
    }
    return;
  }

  // ── Thinking complete: close current bubble so next thinking starts fresh ──
  if (kind === 'thinking_complete') {
    for (let i = ctx.messages.length - 1; i >= 0; i--) {
      const m = ctx.messages[i];
      if (m.kind === 'thinking' && m.role === 'assistant' && !(m as any)._completed) {
        console.log(`[ThinkingTrace] CLOSED thinking bubble id=${ m.id } reason=thinking_complete_kind (channel=${ agentId }, msgThreadId=${ msgThreadId }, bubbleThreadId=${ m.threadId })`);
        (ctx.messages[i] as any)._completed = true;
        break;
      }
    }
    return;
  }

  // ── Thinking: accumulate into a single growing bubble ──
  if (kind === 'thinking' && role === 'assistant') {
    appendThinkingMessage(ctx, agentId, msgThreadId, finalContent,
      msg.type === 'assistant_message' && (data?.reportingActivity === 'tool' || data?.reportingActivity === 'status')
        ? data.reportingActivity : undefined);
    return;
  }

  // ── Non-streaming assistant message: reconcile with any streaming segments ──
  if (role === 'assistant') {
    // Collect recent assistant streaming bubbles (our segmented view of this
    // turn). Walk back until we hit a user message or non-assistant kind.
    const recentStreamIndexes: number[] = [];
    for (let i = ctx.messages.length - 1; i >= 0; i--) {
      const m = ctx.messages[i];
      if (replyBoundary(m) || m.role !== 'assistant') break;
      if (m.kind === 'streaming' && m.threadId === msgThreadId && belongsToReply(m)) recentStreamIndexes.push(i);
    }

    if (!terminalRunError && recentStreamIndexes.length > 0) {
      // The user has already seen the streaming segments. NEVER wipe them
      // here — abort messages, error notices, and other status pings would
      // erase the actual response content (this is the bug where hitting
      // Stop blanked everything except thinking bubbles).
      //
      // Two cases:
      //   1. Incoming content is the post-stream "full reply" dump (matches
      //      the concatenated segments). Drop it — segments already cover it.
      //   2. Incoming content is something else (status, error, abort,
      //      separate follow-up). Let it through as a new bubble alongside
      //      the segments.
      const streamedConcat = recentStreamIndexes
        .slice()
        .reverse()
        .map(i => ctx.messages[i].content || '')
        .join('');
      const incoming = finalContent.trim();
      const streamed = streamedConcat.trim();
      const alreadyShown = streamed.length > 0 && (
        streamed === incoming ||
        (streamed.length >= Math.max(1, incoming.length * 0.6) && incoming.startsWith(streamed)) ||
        streamed.startsWith(incoming)
      );
      if (alreadyShown) {
        // A final dump can carry the last part of a formatted block after
        // a throttled stream update. Keep it in the existing bubble.
        const lastSegment = recentStreamIndexes[0];
        if (recentStreamIndexes.length === 1 && incoming.length > streamed.length && incoming.startsWith(streamed)) {
          ctx.messages[lastSegment] = { ...ctx.messages[lastSegment], content: finalContent };
        }
        if (explicitReferences?.length) ctx.messages[lastSegment] = { ...ctx.messages[lastSegment], ...referenceUpdate };
        // Close any open thinking bubble and swallow the duplicate dump.
        for (let i = ctx.messages.length - 1; i >= 0; i--) {
          const m = ctx.messages[i];
          if (m.kind === 'thinking' && m.role === 'assistant' && !(m as any)._completed) {
            (ctx.messages[i] as any)._completed = true;
            break;
          }
        }
        return;
      }
      // Different content — keep the segments, fall through and append the
      // incoming message as a new bubble below them.
    }

    // Mark any open thinking bubble as completed
    for (let i = ctx.messages.length - 1; i >= 0; i--) {
      const m = ctx.messages[i];
      if (m.kind === 'thinking' && m.role === 'assistant' && !(m as any)._completed) {
        console.log(`[ThinkingTrace] CLOSED thinking bubble id=${ m.id } reason=non_streaming_assistant_arrival (channel=${ agentId }, msgThreadId=${ msgThreadId }, bubbleThreadId=${ m.threadId }, incomingKind=${ kind ?? '(undef)' })`);
        (ctx.messages[i] as any)._completed = true;
        break;
      }
    }
  }

  const message: ChatMessage = {
    id:        uniqueMessageId(ctx, `${ Date.now() }_ws_${ msg.type }`),
    channelId: agentId,
    threadId:  msgThreadId,
    role,
    kind,
    content:   finalContent,
    ...(terminalRunError ? { terminalRunError } : {}),
    ...(agentReporting ? { agentReporting } : {}),
    ...(decisionFollowUpId ? { decisionFollowUpId } : {}),
    ...(replyAttribution ? { replyAttribution } : {}),
    ...referenceUpdate,
  };

  if (kind === 'channel_message') {
    message.channelMeta = {
      senderId:      typeof data?.senderId === 'string' ? data.senderId : 'unknown',
      senderChannel: typeof data?.senderChannel === 'string' ? data.senderChannel : '',
      fromThreadId:  typeof data?.fromThreadId === 'string' ? data.fromThreadId : undefined,
      toThreadId:    typeof data?.toThreadId === 'string' ? data.toThreadId : undefined,
      senderLabel:   typeof data?.senderLabel === 'string' ? data.senderLabel : undefined,
      senderJobId:   typeof data?.senderJobId === 'string' ? data.senderJobId : undefined,
    };
  }
  if (kind === 'a2a_delivery_status' && data?.a2aDeliveryStatus && typeof data.a2aDeliveryStatus.messageId === 'string') {
    message.a2aDeliveryStatus = data.a2aDeliveryStatus;
  }

  if (kind !== 'speak' && finalContent.includes('<speak>')) {
    console.warn(`[MessageDispatcher] ⚠️ LEAKED <speak> tags in non-speak message! kind=${ kind }`);
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
  const voiceTurnId = typeof data?.voiceTurnId === 'string' ? data.voiceTurnId : null;

  console.log(`[MessageDispatcher] speak_dispatch → "${ text.slice(0, 80) }" seq=${ pipelineSequence }`);
  ctx.messages.push({
    id:        `${ Date.now() }_speak`,
    channelId: agentId,
    threadId:  msgThreadId,
    role:      'assistant',
    kind:      'speak',
    content:   text,
  });

  for (const listener of ctx.speakListeners) {
    listener(text, msgThreadId, pipelineSequence, voiceTurnId);
  }
}

// Asset lifecycle handlers (register_or_activate_asset, deactivate_asset)
// were removed. Tabs are now owned by main-process TabRegistry; the agent
// tool opens/closes them directly without WS round-trips.

// ─── Handler: progress / plan_update ────────────────────────────

function handleProgress(ctx: DispatchContext, agentId: string, msgThreadId: string, msg: WebSocketMessage): void {
  const data = (msg.data && typeof msg.data === 'object') ? (msg.data as any) : null;
  const phase = data?.phase;

  if (phase === 'tool_call') {
    const toolRunId = typeof data?.toolRunId === 'string' ? data.toolRunId : null;
    const toolName = typeof data?.toolName === 'string' ? data.toolName : 'unknown';
    const args = data?.args ?? {};
    const argsRecord = args && typeof args === 'object' && !Array.isArray(args)
      ? args as Record<string, unknown>
      : { value: args };
    const fullInput = typeof args === 'string' ? args : JSON.stringify(args, null, 2) ?? String(args);

    ctx.currentActivity.value = toolNameToVerb(toolName);

    // Seal any open streaming bubble. The backend doesn't always emit a
    // `streaming_complete` sentinel at text→tool_use transitions, so without
    // this the next narration segment finds this bubble still "open" and
    // the `streaming` handler overwrites its content in-place (line ~236),
    // clobbering every prior narration in the same slot.
    for (let i = ctx.messages.length - 1; i >= 0; i--) {
      const m = ctx.messages[i];
      if (m.role !== 'assistant') break;
      if (m.kind === 'streaming' && !(m as any)._completed) {
        (ctx.messages[i] as any)._completed = true;
        break;
      }
    }

    // Every tool call stays structured so the renderer can retain its exact
    // arguments, status, result and error in the saved transcript.

    if (toolRunId) {
      const existingId = ctx.toolRunIdToMessageId.get(toolRunId);
      if (existingId && ctx.messages.some(message => message.id === existingId && message.threadId === msgThreadId)) return;
      const messageId = `${ Date.now() }_tool_${ toolRunId }`;
      const description = typeof argsRecord.description === 'string' ? argsRecord.description : undefined;
      const display = formatToolCard(toolName, argsRecord);
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
            providerTool: data?.kind === 'provider',
          description,
          status:       'running',
          args:         argsRecord,
          label:        display.label,
          summary:      display.summary,
          input:        fullInput,
          inputIsFull:  true,
          outputFormat: display.outputFormat,
        },
      };
      ctx.messages.push(message);
      ctx.toolRunIdToMessageId.set(toolRunId, messageId);
    }
  }

  if (phase === 'tool_result') {
    ctx.currentActivity.value = 'Thinking';
    const toolRunId = typeof data?.toolRunId === 'string' ? data.toolRunId : null;
    if (toolRunId) {
      const messageId = ctx.toolRunIdToMessageId.get(toolRunId);
      if (messageId) {
        const message = ctx.messages.find(m => m.id === messageId);
        if (message?.toolCard) new ToolResultCardProjector(formatToolResult, TOOL_PAYLOAD_POINTER_THRESHOLD)
          .project(message.toolCard, data, msgThreadId);
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
    ? roleRaw
    : 'assistant';

  ctx.messages.push({
    id:        `${ Date.now() }_ws_chat_image`,
    channelId: agentId,
    threadId:  msgThreadId,
    role,
    content:   '',
    image:     { dataUrl: src, alt, path },
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
    // Only reject completion events when we're SURE they're from a different
    // thread (both IDs present and mismatched). If either ID is missing, accept
    // the completion to avoid leaving the UI stuck in "running" state.
    const eventThreadId = data?.thread_id || data?.threadId;
    const activeThreadId = ctx.getThreadId();
    if (activeThreadId && eventThreadId && eventThreadId !== activeThreadId) {
      console.log('[MessageDispatcher] Ignoring graph_execution_complete: thread mismatch (event:', eventThreadId, ', active:', activeThreadId, ')');
      return;
    }

    const reason = data?.stopReason || null;
    const waiting = !!(data?.waitingForUser);
    console.log('[MessageDispatcher] Graph execution complete, stopReason:', reason, 'waitingForUser:', waiting);
    ctx.graphRunning.value = false;
    ctx.waitingForUser.value = waiting;
    ctx.stopReason.value = reason;
    ctx.registry.setLoading(agentId, false);

    // Mark all open thinking bubbles as completed so the helix/timer stops
    for (let i = ctx.messages.length - 1; i >= 0; i--) {
      const m = ctx.messages[i];
      if (m.kind === 'thinking' && m.role === 'assistant' && !(m as any)._completed) {
        console.log(`[ThinkingTrace] CLOSED thinking bubble id=${ m.id } reason=graph_execution_complete (channel=${ agentId }, bubbleThreadId=${ m.threadId })`);
        (ctx.messages[i] as any)._completed = true;
      }
    }
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
      if ((m.metadata)?._conversationSummary) continue;
      const role = m.role === 'user' ? 'user' : 'assistant';
      const content = stripProtocolTagsForUi(contentToString(m.content));
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
      id:           `${ Date.now() }_wf_started`,
      channelId:    agentId,
      threadId:     msgThreadId,
      role:         'assistant',
      kind:         'workflow_node',
      content:      '',
      workflowNode: {
        workflowRunId,
        nodeId:    '',
        nodeLabel: 'Workflow Started',
        status:    'running',
        nodeIndex: 0,
        totalNodes,
      },
    });
    return;
  }

  if (eventType === 'node_started') {
    ctx.messages.push({
      id:           `${ Date.now() }_wf_node_${ nodeId }`,
      channelId:    agentId,
      threadId:     msgThreadId,
      role:         'assistant',
      kind:         'workflow_node',
      content:      '',
      workflowNode: {
        workflowRunId,
        nodeId,
        nodeLabel,
        status: 'running',
        prompt: typeof data.prompt === 'string' ? data.prompt : undefined,
        nodeIndex,
        totalNodes,
      },
    });
    return;
  }

  if (eventType === 'node_completed' || eventType === 'node_failed' || eventType === 'node_waiting') {
    const existing = [...ctx.messages].reverse().find(
      m => m.workflowNode?.nodeId === nodeId && m.workflowNode?.status === 'running',
    );
    if (existing?.workflowNode) {
      existing.workflowNode.status = eventType === 'node_completed'
        ? 'completed'
        : eventType === 'node_failed' ? 'failed' : 'waiting';
      if (data.output !== undefined) {
        existing.workflowNode.output = typeof data.output === 'string'
          ? data.output
          : JSON.stringify(data.output);
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
        id:               `${ Date.now() }_sub_agent_${ nodeId }`,
        channelId:        agentId,
        threadId:         msgThreadId,
        role:             'assistant',
        kind:             'sub_agent_activity',
        content:          '',
        subAgentActivity: {
          nodeId,
          nodeLabel:      nodeLabel || nodeId,
          status:         'running',
          thinkingLines:  [thinkingContent],
          latestThinking: thinkingContent,
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
          ? data.output
          : JSON.stringify(data.output);
      }
      if (data.error) existing.subAgentActivity.error = String(data.error);
    }
  }

  // edge_activated and other sub-events are visual-only (canvas), skip chat
}

// ─── Protocol no-ops ────────────────────────────────────────────

function handleNoop(): void { /* protocol-level — nothing to do */ }

// ─── Helper (moved from AgentPersonaModel module scope) ─────────

const TOOL_VERB_MAP: Record<string, string> = {
  // Execution
  exec:                        'Running',
  exec_command:                'Running',
  shell:                       'Running',
  bash:                        'Running',
  run_command:                 'Running',
  exechost:                    'Running on host',
  // Search
  file_search:                 'Searching',
  // Git / GitHub
  git_status:                  'Checking status',
  git_log:                     'Reviewing history',
  git_diff:                    'Comparing changes',
  git_add:                     'Staging',
  git_commit:                  'Committing',
  git_push:                    'Pushing',
  git_pull:                    'Pulling',
  git_branch:                  'Branching',
  git_checkout:                'Switching branch',
  git_stash:                   'Stashing',
  git_blame:                   'Blaming',
  git_conflicts:               'Resolving conflicts',
  github_create_pr:            'Creating PR',
  github_create_issue:         'Creating issue',
  github_get_issue:            'Fetching issue',
  github_get_issues:           'Fetching issues',
  github_read_file:            'Reading',
  github_create_file:          'Creating',
  github_update_file:          'Updating',
  github_comment_on_issue:     'Commenting',
  // Docker
  docker_build:                'Building image',
  docker_run:                  'Running container',
  docker_exec:                 'Executing',
  docker_ps:                   'Listing containers',
  docker_logs:                 'Reading logs',
  docker_pull:                 'Pulling image',
  docker_stop:                 'Stopping container',
  docker_rm:                   'Removing container',
  docker_images:               'Listing images',
  // Database
  pg_query:                    'Querying',
  pg_queryall:                 'Querying',
  pg_queryone:                 'Querying',
  pg_execute:                  'Executing SQL',
  pg_count:                    'Counting',
  pg_transaction:              'Running transaction',
  // Redis
  redis_get:                   'Reading cache',
  redis_set:                   'Writing cache',
  redis_del:                   'Clearing cache',
  // Workflows
  execute_workflow:            'Running workflow',
  validate_workflow:           'Validating workflow',
  patch_workflow:              'Patching workflow',
  diagnose_webhook:            'Diagnosing webhook',
  // Playwright / Browser
  click_element:               'Clicking',
  get_page_snapshot:           'Capturing page',
  get_page_text:               'Reading page',
  set_field:                   'Filling form',
  scroll_to_element:           'Scrolling',
  // Slack
  slack_send_message:          'Messaging',
  slack_search_users:          'Searching users',
  // Calendar
  calendar_list:               'Checking calendar',
  calendar_create:             'Creating event',
  calendar_list_upcoming:      'Checking schedule',
  // Skills / Projects
  create_skill:                'Creating skill',
  // Channel
  send_notification_to_human:  'Notifying',
};

function toolNameToVerb(toolName: string): string {
  if (TOOL_VERB_MAP[toolName]) return TOOL_VERB_MAP[toolName];

  // Prefix-based fallbacks
  if (toolName.startsWith('fs_')) return 'Working with files';
  if (toolName.startsWith('git')) return 'Using git';
  if (toolName.startsWith('docker_')) return 'Using Docker';
  if (toolName.startsWith('kubectl_')) return 'Using kubectl';
  if (toolName.startsWith('pg_')) return 'Querying database';
  if (toolName.startsWith('redis_')) return 'Using cache';
  if (toolName.startsWith('slack_')) return 'Using Slack';
  if (toolName.includes('workflow')) return 'Working on workflow';

  return 'Working';
}

// ─── Factory ────────────────────────────────────────────────────

/**
 * Creates a MessageDispatcher with all standard handlers registered.
 */
export function createMessageDispatcher(): MessageDispatcher {
  const dispatcher = new MessageDispatcher();

  // Chat messages (4 aliases for primary, 1 for subconscious)
  // All flow through handleChatMessage for shared bubble-rendering logic.
  // The handler gates run-state updates on msg.type so subconscious
  // emissions don't flip graphRunning.
  dispatcher.register('chat_message', handleChatMessage);
  dispatcher.register('assistant_message', handleChatMessage);
  dispatcher.register('user_message', handleChatMessage);
  dispatcher.register('system_message', handleChatMessage);
  dispatcher.register('subconscious_message', handleChatMessage);

  // Speak
  dispatcher.register('speak_dispatch', handleSpeakDispatch);

  // Assets
  // register_or_activate_asset / deactivate_asset handlers removed —
  // see TabRegistry.

  // Progress / tools
  dispatcher.register('progress', handleProgress);
  dispatcher.register('plan_update', handleProgress);

  // Media
  dispatcher.register('chat_image', handleChatImage);

  // State
  dispatcher.register('transfer_data', handleTransferData);
  dispatcher.register('thread_created', handleThreadCreated);
  dispatcher.register('thread_restored', handleThreadRestored);
  dispatcher.register('token_info', handleTokenInfo);

  // Workflow
  dispatcher.register('workflow_execution_event', handleWorkflowExecutionEvent);

  // Inject (frontend→backend only; no-op if echoed back since UI is already updated optimistically)
  dispatcher.register('inject_message', handleNoop);

  // Protocol no-ops
  dispatcher.register('ack', handleNoop);
  dispatcher.register('ping', handleNoop);
  dispatcher.register('pong', handleNoop);
  dispatcher.register('subscribe', handleNoop);
  dispatcher.register('stop_run', handleNoop);

  return dispatcher;
}

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
import { formatToolCard, formatToolResult } from '@pkg/agent/tools/toolCardFormatters';
import { dispatchLogger as console } from '@pkg/agent/utils/agentLogger';

import type { ChatMessage, AgentPersonaRegistry } from '../registry/AgentPersonaRegistry';
import type { Ref } from 'vue';

// ─── Display caps ───────────────────────────────────────────────
// Renderer-side caps that stop a single tool result or a runaway
// thinking bubble from blowing out the chat window's V8 heap,
// localStorage quota, or DOM. Agent context is unaffected — these
// caps apply only to what we store in reactive state for display.

const MAX_TOOL_RESULT_CHARS = 20_000;
const MAX_THINKING_CHARS    = 10_000;

function capForDisplay(v: unknown, max = MAX_TOOL_RESULT_CHARS): unknown {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? null);
  if (s.length <= max) return v;
  return `${ s.slice(0, max) }\n\n[truncated ${ s.length - max } chars]`;
}

function capText(s: string, max: number): string {
  return s.length <= max ? s : s.slice(s.length - max);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    } else {
      console.log('[MessageDispatcher] Unhandled message type:', msg.type);
    }
  }
}

// ─── Handler: chat / assistant / system messages ────────────────

function handleChatMessage(ctx: DispatchContext, agentId: string, msgThreadId: string, msg: WebSocketMessage): void {
  ctx.graphRunning.value = true;

  // [DBLDBG] Doubling investigation — log EVERY incoming chat-class message
  // before any drop / dedup so we can match against [BaseNode:wsChatMessage]
  // emits and renderer-side appends.
  {
    const dataObj = (msg.data && typeof msg.data === 'object') ? (msg.data as any) : null;
    const rawContent = typeof msg.data === 'string'
      ? msg.data
      : (dataObj?.content !== undefined ? String(typeof dataObj.content === 'string' ? dataObj.content : JSON.stringify(dataObj.content)) : '');
    const trimmed = rawContent.trim();
    let h = 0;
    for (let i = 0; i < trimmed.length; i++) h = ((h << 5) - h + trimmed.charCodeAt(i)) | 0;
    const contentHash = (h >>> 0).toString(16).padStart(8, '0');
    const kindStr = typeof dataObj?.kind === 'string' ? dataObj.kind : '(none)';
    console.log(`[DBLDBG][MessageDispatcher:handleChatMessage] inbound type="${ msg.type }" channel="${ agentId }" thread="${ msgThreadId }" kind="${ kindStr }" hash=${ contentHash } len=${ trimmed.length } chatMsgsBefore=${ ctx.messages.length } preview="${ trimmed.slice(0, 80).replace(/\n/g, '\\n') }"`);
  }

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
    // [DBLDBG] Hash the string payload so this string-push pairs against
    // the corresponding INBOUND log line by hash.
    {
      let h = 0;
      for (let i = 0; i < message.content.length; i++) h = ((h << 5) - h + message.content.charCodeAt(i)) | 0;
      const contentHash = (h >>> 0).toString(16).padStart(8, '0');
      console.log(`[DBLDBG][MessageDispatcher:push-string] type="${ msg.type }" id="${ message.id }" hash=${ contentHash } len=${ message.content.length } chatMsgsAfter=${ ctx.messages.length + 1 }`);
    }
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

  const content = data?.content !== undefined ? contentToString(data.content) : '';

  // Segment-boundary sentinels: kind carries the meaning, content is empty
  // by design. Must be handled BEFORE the empty-content drop or the signal
  // gets swallowed and the streaming/thinking bubbles never close.
  const kindRaw = typeof data?.kind === 'string' ? data.kind : undefined;
  if (kindRaw === 'streaming_complete' || kindRaw === 'thinking_complete') {
    const target = kindRaw === 'streaming_complete' ? 'streaming' : 'thinking';
    for (let i = ctx.messages.length - 1; i >= 0; i--) {
      const m = ctx.messages[i];
      if (m.kind === target && m.role === 'assistant' && !(m as any)._completed) {
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

    ctx.messages.push({
      id:        `${ Date.now() }_ws_citation`,
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

    ctx.messages.push({
      id:        `${ Date.now() }_ws_tool_approval_${ approvalId }`,
      channelId: agentId,
      threadId:  msgThreadId,
      role:      'assistant',
      kind:      'tool_approval',
      content:   '',
      toolApproval: {
        approvalId,
        reason,
        command,
        origin: ta?.origin && typeof ta.origin === 'object' ? ta.origin : undefined,
      },
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

    ctx.messages.push({
      id:        `${ Date.now() }_ws_proactive`,
      channelId: agentId,
      threadId:  msgThreadId,
      role:      'assistant',
      kind:      'proactive',
      content:   body,
      proactive: { headline: headline || 'Sulla', body },
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
  let kind = (typeof data?.kind === 'string') ? data.kind : undefined;
  let finalContent = content;

  if (kind === 'speak') {
    console.log(`[MessageDispatcher] SPEAK received → channel="${ agentId }", thread="${ msgThreadId }", content="${ content.slice(0, 80) }"`);
  }

  // Auto-detect HTML
  if (!kind || kind === 'text' || kind === 'progress') {
    const htmlMatch = /^\s*<html>([\s\S]*)<\/html>\s*$/i.exec(finalContent);
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
      msgType:        msg.type,
      channel:        agentId,
      role,
      kind,
      contentLength:  trimmed.length,
      contentPreview: trimmed.substring(0, 500),
    });
  }

  // ── Streaming: update in-place, but respect segment boundaries ──
  if (kind === 'streaming' && role === 'assistant') {
    // Only reuse a streaming bubble if it hasn't been marked complete
    // (e.g. by a preceding streaming_complete event or a thinking event
    // arriving mid-stream). Otherwise this token belongs to a new segment.
    let existingIdx = -1;
    for (let i = ctx.messages.length - 1; i >= 0; i--) {
      const m = ctx.messages[i];
      if (m.kind === 'streaming' && m.role === 'assistant' && !(m as any)._completed) {
        existingIdx = i;
        break;
      }
    }
    if (existingIdx !== -1) {
      ctx.messages[existingIdx] = { ...ctx.messages[existingIdx], content: finalContent };
    } else {
      // First streaming chunk of a new segment — collapse any open thinking bubble
      for (let i = ctx.messages.length - 1; i >= 0; i--) {
        const m = ctx.messages[i];
        if (m.kind === 'thinking' && m.role === 'assistant' && !(m as any)._completed) {
          (ctx.messages[i] as any)._completed = true;
          break;
        }
      }
      ctx.messages.push({
        id:        `${ Date.now() }_ws_streaming`,
        channelId: agentId,
        threadId:  msgThreadId,
        role,
        kind,
        content:   finalContent,
      });
    }
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
      ctx.messages[existingIdx] = { ...existing, content: capText(existing.content + '\n\n' + finalContent, MAX_THINKING_CHARS) };
    } else {
      ctx.messages.push({
        id:        `${ Date.now() }_ws_thinking`,
        channelId: agentId,
        threadId:  msgThreadId,
        role,
        kind:      'thinking',
        content:   finalContent,
      });
    }
    return;
  }

  // ── Non-streaming assistant message: reconcile with any streaming segments ──
  if (role === 'assistant') {
    // Collect recent assistant streaming bubbles (our segmented view of this
    // turn). Walk back until we hit a user message or non-assistant kind.
    const recentStreamIndexes: number[] = [];
    for (let i = ctx.messages.length - 1; i >= 0; i--) {
      const m = ctx.messages[i];
      if (m.role !== 'assistant') break;
      if (m.kind === 'streaming') recentStreamIndexes.push(i);
    }

    if (recentStreamIndexes.length > 0) {
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
        (ctx.messages[i] as any)._completed = true;
        break;
      }
    }
  }

  const message: ChatMessage = {
    id:        `${ Date.now() }_ws_${ msg.type }`,
    channelId: agentId,
    threadId:  msgThreadId,
    role,
    kind,
    content:   finalContent,
  };

  if (kind === 'channel_message') {
    message.channelMeta = {
      senderId:      typeof data?.senderId === 'string' ? data.senderId : 'unknown',
      senderChannel: typeof data?.senderChannel === 'string' ? data.senderChannel : '',
    };
  }

  if (kind !== 'speak' && finalContent.includes('<speak>')) {
    console.warn(`[MessageDispatcher] ⚠️ LEAKED <speak> tags in non-speak message! kind=${ kind }`);
  }

  // [DBLDBG] Hash the final pushed content so we can grep-pair this
  // PUSH against the corresponding INBOUND log line above.
  {
    let h = 0;
    for (let i = 0; i < message.content.length; i++) h = ((h << 5) - h + message.content.charCodeAt(i)) | 0;
    const contentHash = (h >>> 0).toString(16).padStart(8, '0');
    console.log(`[DBLDBG][MessageDispatcher:push-structured] type="${ msg.type }" id="${ message.id }" kind="${ message.kind }" hash=${ contentHash } len=${ message.content.length } chatMsgsAfter=${ ctx.messages.length + 1 }`);
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
    listener(text, msgThreadId, pipelineSequence);
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
    const args = data?.args && typeof data.args === 'object' ? data.args : {};

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

    // Skip chat-only tools
    if (toolName === 'emit_chat_message' || toolName === 'emit_chat_image') {
      return;
    }

    // Render lightweight tools as thinking text, not tool cards
    const THINKING_TOOL_NAMES = new Set([
      'file_search', 'read_file',
      'add_observational_memory', 'remove_observational_memory',
      'vault_list', 'search_conversations',
      'search_history', 'github_read_file', 'get_human_presence', 'list_tabs',
      'check_agent_jobs', 'github_get_issue', 'github_get_issues',
      'github_list_branches', 'git_log',
    ]);
    if (THINKING_TOOL_NAMES.has(toolName)) {
      let thinkingText = '';
      if (toolName === 'file_search') {
        const query = typeof args.query === 'string' ? args.query : '';
        const dir = (typeof args.dirPath === 'string' ? args.dirPath : '~').replace(/^\/Users\/[^/]+/, '~');
        thinkingText = `Searching for "${ query }" in ${ dir }`;
      } else if (toolName === 'add_observational_memory') {
        const content = typeof args.content === 'string' ? args.content : '';
        const truncated = content.length > 80 ? content.slice(0, 80) + '...' : content;
        thinkingText = `Remembering: "${ truncated }"`;
      } else if (toolName === 'remove_observational_memory') {
        const id = typeof args.id === 'string' ? args.id : '';
        thinkingText = `Forgetting observation ${ id }`;
      } else if (toolName === 'vault_list') {
        thinkingText = 'Checking saved credentials in vault';
      } else if (toolName === 'search_conversations') {
        const action = typeof args.action === 'string' ? args.action : 'search';
        const query = typeof args.query === 'string' ? args.query : '';
        const type = typeof args.type === 'string' ? ` (${ args.type })` : '';
        if (action === 'search' && query) {
          thinkingText = `Searching conversations for "${ query }"${ type }`;
        } else if (action === 'recent') {
          thinkingText = `Loading recent conversations${ type }`;
        } else if (action === 'get') {
          const id = typeof args.id === 'string' ? args.id : typeof args.threadId === 'string' ? args.threadId : '';
          thinkingText = `Retrieving conversation ${ id }`;
        } else {
          thinkingText = `Searching conversations${ query ? ` for "${ query }"` : '' }`;
        }
      } else if (toolName === 'search_history') {
        const query = typeof args.query === 'string' ? args.query : '';
        thinkingText = query ? `Searching browsing history for "${ query }"` : 'Browsing recent history';
      } else if (toolName === 'github_read_file') {
        const owner = typeof args.owner === 'string' ? args.owner : '';
        const repo = typeof args.repo === 'string' ? args.repo : '';
        const path = typeof args.path === 'string' ? args.path : '';
        const ref = typeof args.ref === 'string' ? ` @ ${ args.ref }` : '';
        thinkingText = `Reading ${ owner }/${ repo }/${ path }${ ref }`;
      } else if (toolName === 'get_human_presence') {
        thinkingText = 'Checking if user is available';
      } else if (toolName === 'list_tabs') {
        thinkingText = 'Checking open browser tabs';
      } else if (toolName === 'check_agent_jobs') {
        const jobId = typeof args.jobId === 'string' ? args.jobId : '';
        thinkingText = jobId ? `Checking agent job ${ jobId }` : 'Checking all agent jobs';
      } else if (toolName === 'github_get_issue') {
        const owner = typeof args.owner === 'string' ? args.owner : '';
        const repo = typeof args.repo === 'string' ? args.repo : '';
        const num = typeof args.issue_number === 'number' ? args.issue_number : '';
        thinkingText = `Reading issue ${ owner }/${ repo }#${ num }`;
      } else if (toolName === 'github_get_issues') {
        const owner = typeof args.owner === 'string' ? args.owner : '';
        const repo = typeof args.repo === 'string' ? args.repo : '';
        const state = typeof args.state === 'string' ? args.state : 'open';
        thinkingText = `Listing ${ state } issues on ${ owner }/${ repo }`;
      } else if (toolName === 'github_list_branches') {
        const owner = typeof args.owner === 'string' ? args.owner : '';
        const repo = typeof args.repo === 'string' ? args.repo : '';
        thinkingText = `Listing branches on ${ owner }/${ repo }`;
      } else if (toolName === 'git_log') {
        const dir = (typeof args.absolutePath === 'string' ? args.absolutePath : '').replace(/^\/Users\/[^/]+/, '~');
        const limit = typeof args.limit === 'number' ? args.limit : 20;
        thinkingText = `Reviewing last ${ limit } commits in ${ dir }`;
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
        ctx.messages[existingIdx] = { ...existing, content: capText(existing.content + '\n\n' + thinkingText, MAX_THINKING_CHARS) };
      } else {
        ctx.messages.push({
          id:        `${ Date.now() }_ws_thinking`,
          channelId: agentId,
          threadId:  msgThreadId,
          role:      'assistant',
          kind:      'thinking',
          content:   thinkingText,
        });
      }
      return;
    }

    if (toolRunId) {
      const messageId = `${ Date.now() }_tool_${ toolRunId }`;
      const description = typeof args?.description === 'string' ? args.description : undefined;
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
      ctx.messages.push(message);
      ctx.toolRunIdToMessageId.set(toolRunId, messageId);
    }
  }

  if (phase === 'tool_result') {
    ctx.currentActivity.value = 'Thinking';
    const toolRunId = typeof data?.toolRunId === 'string' ? data.toolRunId : null;
    const success = data?.success === true;
    const error = typeof data?.error === 'string' ? data.error : null;
    const result = capForDisplay(data?.result);

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
          if (resultDisplay.output) message.toolCard.output = capForDisplay(resultDisplay.output) as string;
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
    // Only react to completion events for the active thread — subconscious
    // agents can complete on the same channel and must not poison main UI state.
    // If activeThreadId is set we require an exact match; a missing eventThreadId
    // (e.g. from a heartbeat/subconscious graph) must also be ignored.
    const eventThreadId = data?.thread_id || data?.threadId;
    const activeThreadId = ctx.getThreadId();
    if (activeThreadId && (!eventThreadId || eventThreadId !== activeThreadId)) {
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
      const content = contentToString(m.content);
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
  // Kubernetes
  kubectl_apply:               'Applying manifest',
  kubectl_delete:              'Deleting resource',
  kubectl_describe:            'Describing resource',
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
  // N8n / Workflows
  execute_workflow:            'Running workflow',
  validate_workflow:           'Validating workflow',
  patch_workflow:              'Patching workflow',
  diagnose_webhook:            'Diagnosing webhook',
  restart_n8n_container:       'Restarting n8n',
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
  // Memory
  add_observational_memory:    'Remembering',
  remove_observational_memory: 'Forgetting',
  // Skills / Projects
  create_skill:                'Creating skill',
  // Lima
  lima_shell:                  'Running shell',
  lima_start:                  'Starting VM',
  lima_stop:                   'Stopping VM',
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
  dispatcher.register('chat_message', handleChatMessage);
  dispatcher.register('assistant_message', handleChatMessage);
  dispatcher.register('user_message', handleChatMessage);
  dispatcher.register('system_message', handleChatMessage);

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

/**
 * ToolExecutor — extracted from BaseNode.ts
 *
 * Handles all tool execution concerns:
 *  - Policy checking (access control, category filtering, agent config allowlists)
 *  - WebSocket event emission (tool_call / tool_result progress events)
 *  - Result formatting & state message persistence
 *  - Structured tool run record persistence (deduplication index)
 *  - Training data logging
 *  - Conversation logging
 *
 * BaseNode delegates to this via `processPendingToolCalls()` and `executeToolCalls()`.
 */

import type { BaseThreadState } from '../nodes/Graph';
import type { ToolResult } from '../types';
import type { NodeRunContext } from '../nodes/BaseNode';
import { throwIfAborted } from '../services/AbortService';
import { getWebSocketClientService } from '../services/WebSocketClientService';
import { toolRegistry } from '../tools/registry';
import { BaseTool } from '../tools/base';
import { stripProtocolTags } from '../utils/stripProtocolTags';
import type { NormalizedResponse, ChatMessage } from '../languagemodels/BaseLanguageModel';

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_WS_CHANNEL = 'heartbeat';

// ============================================================================
// Context interface — everything the executor needs from the calling node
// ============================================================================

export interface ToolExecutorContext {
  /** Node identity */
  nodeId:   string;
  nodeName: string;

  /** Current node run context (null when not inside an LLM call) */
  currentNodeRunContext: NodeRunContext | null;

  /** Send a chat message over WebSocket */
  wsChatMessage(state: BaseThreadState, content: string, role?: 'assistant' | 'system', kind?: string): Promise<boolean>;

  /** Bump state version (currently a no-op but part of the contract) */
  bumpStateVersion(state: BaseThreadState): void;
}

// ============================================================================
// ToolExecutor
// ============================================================================

export class ToolExecutor {
  constructor(private readonly ctx: ToolExecutorContext) {}

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Process pending tool calls from an LLM reply.
   * Wrapper so callers of normalizedChat can control when tool execution
   * happens relative to other work (e.g. emitting text to the UI first).
   */
  async processPendingToolCalls(
    state: BaseThreadState,
    reply: { metadata: { tool_calls?: { name: string; id?: string; args: any }[] } },
  ): Promise<void> {
    const toolCalls = reply.metadata.tool_calls || [];
    if (toolCalls.length) {
      console.log(`[${ this.ctx.nodeName }] Processing ${ toolCalls.length } tool calls via executeToolCalls`);
      await this.executeToolCalls(state, toolCalls);
    }
  }

  /**
   * Execute multiple tool calls, append results as 'tool' messages, return results array.
   * - Appends each result immediately after execution (LLM sees sequential feedback)
   * - Uses role: 'tool' + name/tool_call_id for API compatibility
   * - Failed tools include help info
   */
  async executeToolCalls(
    state: BaseThreadState,
    toolCalls: { name: string; id?: string; args: any }[],
    allowedTools?: string[],
  ): Promise<{ toolName: string; success: boolean; result?: unknown; error?: string }[]> {
    if (!toolCalls?.length) return [];

    state.metadata.hadToolCalls = true;
    if (this.ctx.currentNodeRunContext) {
      this.ctx.currentNodeRunContext.hadToolCalls = true;
    }

    throwIfAborted(state, 'Tool execution aborted');

    const results: { toolName: string; success: boolean; result?: unknown; error?: string }[] = [];

    for (const call of toolCalls) {
      throwIfAborted(state, `Tool execution aborted before ${ call.name }`);

      const toolRunId = call.id || `${ call.name }_${ Date.now() }_${ Math.random().toString(36).substr(2, 9) }`;
      const toolName = call.name;
      const args = call.args;

      // --- Consecutive loop detection ---
      // Block only after the same exact call has been made LOOP_THRESHOLD times
      // in a row. A single retry is normal (e.g. transient failure, corrected
      // context); only sustained repetition signals a real loop.
      const LOOP_THRESHOLD = 7;
      const dedupeKey = this.buildToolRunDedupeKey(toolName, args);
      const metadataAny = state.metadata as any;
      const toolRuns = metadataAny.__toolRuns as { dedupeKey: string }[] | undefined;
      let consecutiveCount = 0;
      if (toolRuns?.length) {
        for (let i = toolRuns.length - 1; i >= 0; i--) {
          if (toolRuns[i].dedupeKey === dedupeKey) {
            consecutiveCount++;
          } else {
            break;
          }
        }
      }
      if (consecutiveCount >= LOOP_THRESHOLD) {
        const loopMsg = `Loop detected: this exact tool call ("${ toolName }" with the same arguments) was executed ${ consecutiveCount } times consecutively. Use the previous result instead of calling it again.`;
        await this.emitToolCallEvent(state, toolRunId, toolName, args);
        await this.emitToolResultEvent(state, toolRunId, false, loopMsg);
        await this.appendToolResultMessage(state, toolName, {
          toolName, success: false, error: loopMsg, toolCallId: toolRunId,
        });
        results.push({ toolName, success: false, error: loopMsg });
        this.pushToTranscript(toolName, false, loopMsg);
        continue;
      }

      // --- Policy block check ---
      const policyBlockReason = await this.getToolPolicyBlockReason(state, toolName);
      if (policyBlockReason) {
        await this.emitToolCallEvent(state, toolRunId, toolName, args);
        await this.emitToolResultEvent(state, toolRunId, false, policyBlockReason);
        await this.appendToolResultMessage(state, toolName, {
          toolName, success: false, error: policyBlockReason, toolCallId: toolRunId,
        });
        this.persistStructuredToolRunRecord(state, {
          toolName, toolRunId, args, success: false, error: policyBlockReason,
        });
        results.push({ toolName, success: false, error: policyBlockReason });
        this.pushToTranscript(toolName, false, policyBlockReason);
        continue;
      }

      // --- Allowlist check ---
      if (allowedTools?.length && !allowedTools.includes(toolName)) {
        const err = `Tool not allowed in this node: ${ toolName }`;
        await this.emitToolCallEvent(state, toolRunId, toolName, args);
        await this.emitToolResultEvent(state, toolRunId, false, err);
        await this.appendToolResultMessage(state, toolName, {
          toolName, success: false, error: err, toolCallId: toolRunId,
        });
        this.persistStructuredToolRunRecord(state, {
          toolName, toolRunId, args, success: false, error: err,
        });
        results.push({ toolName, success: false, error: 'Not allowed' });
        this.pushToTranscript(toolName, false, err);
        continue;
      }

      try {
        const tool = await toolRegistry.getTool(toolName);

        await this.emitToolCallEvent(state, toolRunId, toolName, args);

        try {
          // Inject WebSocket capabilities into the tool
          if (tool instanceof BaseTool) {
            tool.setState(state);
            tool.sendChatMessage = (content: string, kind = 'progress') =>
              this.ctx.wsChatMessage(state, content, 'assistant', kind);
            tool.emitProgress = async(data: any) => {
              await this.dispatchToWebSocket(state.metadata.wsChannel || DEFAULT_WS_CHANNEL, {
                type:      'progress_update',
                data:      { ...data, kind: 'progress', thread_id: state.metadata.threadId },
                timestamp: Date.now(),
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
            toolName, success: toolSuccess, result, error: toolError, toolCallId: toolRunId,
          });
          this.persistStructuredToolRunRecord(state, {
            toolName, toolRunId, args, success: toolSuccess, result, error: toolError,
          });
          results.push({ toolName, success: toolSuccess, result, error: toolError });
          this.pushToTranscript(toolName, toolSuccess, toolError, result);

          // Conversation logging
          const convIdSuccess = (state.metadata as any).conversationId;
          if (convIdSuccess) {
            try {
              const { getConversationLogger: getLogger } = require('../services/ConversationLogger');
              getLogger().logToolCall(convIdSuccess, toolName, args, result);
            } catch { /* best-effort */ }
          }
        } catch (err: any) {
          const error = err.message || String(err);
          await this.emitToolResultEvent(state, toolRunId, false, error);
          await this.appendToolResultMessage(state, toolName, {
            toolName, success: false, error, toolCallId: toolRunId,
          });
          this.persistStructuredToolRunRecord(state, {
            toolName, toolRunId, args, success: false, error,
          });
          results.push({ toolName, success: false, error });

          // Conversation logging for failed tool calls
          const convIdFail = (state.metadata as any).conversationId;
          if (convIdFail) {
            try {
              const { getConversationLogger: getLogger } = require('../services/ConversationLogger');
              getLogger().logToolCall(convIdFail, toolName, args, { error });
            } catch { /* best-effort */ }
          }
          this.pushToTranscript(toolName, false, error);
        }
      } catch {
        await this.emitToolCallEvent(state, toolRunId, toolName, args);
        await this.emitToolResultEvent(state, toolRunId, false, `Unknown tool: ${ toolName }`);
        await this.appendToolResultMessage(state, toolName, {
          toolName, success: false, error: `Unknown tool: ${ toolName }`, toolCallId: toolRunId,
        });
        this.persistStructuredToolRunRecord(state, {
          toolName, toolRunId, args, success: false, error: `Unknown tool: ${ toolName }`,
        });
        results.push({ toolName, success: false, error: 'Unknown tool' });
        this.pushToTranscript(toolName, false, 'Unknown tool');
        continue;
      }
    }

    return results;
  }

  // --------------------------------------------------------------------------
  // Policy
  // --------------------------------------------------------------------------

  async getToolPolicyBlockReason(state: BaseThreadState, toolName: string): Promise<string | null> {
    const policy = (state.metadata as any).__toolAccessPolicy as {
      allowedCategories: string[] | null;
      allowedToolNames:  string[] | null;
    } | undefined;

    if (!policy) return null;

    const allowedToolNames = policy.allowedToolNames;
    if (allowedToolNames?.length && !allowedToolNames.includes(toolName)) {
      return `Tool not allowed by name policy: ${ toolName }`;
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
      return `Tool category not allowed in this node: ${ toolName } (category: ${ category || 'unknown' })`;
    }

    // Agent config tool allowlist (defense in depth)
    const agentTools = (state.metadata as any).agent?.tools;
    if (Array.isArray(agentTools) && agentTools.length > 0) {
      const metaNames = toolRegistry.getToolNamesForCategory('meta');
      if (!agentTools.includes(toolName) && !metaNames.includes(toolName)) {
        return `Tool not allowed by agent config: ${ toolName }`;
      }
    }

    return null;
  }

  buildToolAccessPolicyForCall(options: {
    allowedToolCategories?: string[];
    allowedToolNames?:      string[];
  }): {
    allowedCategories: string[] | null;
    allowedToolNames:  string[] | null;
  } {
    const allowedCategories = options.allowedToolCategories?.length
      ? [...new Set(options.allowedToolCategories)]
      : null;
    const allowedToolNames = options.allowedToolNames?.length
      ? [...new Set(options.allowedToolNames)]
      : null;

    return { allowedCategories, allowedToolNames };
  }

  async filterLLMToolsByAccessPolicy(
    llmTools: any[],
    options: { allowedToolCategories?: string[]; allowedToolNames?: string[] },
  ): Promise<{ tools: any[] }> {
    const hasRestrictions = Boolean(options.allowedToolCategories?.length || options.allowedToolNames?.length);
    if (!hasRestrictions) return { tools: llmTools };

    const allowedCategories = options.allowedToolCategories?.length
      ? new Set(options.allowedToolCategories)
      : null;
    const allowedNames = options.allowedToolNames?.length
      ? new Set(options.allowedToolNames)
      : null;

    const filtered: any[] = [];
    for (const tool of llmTools) {
      const name = tool.function?.name || tool.name;
      if (!name) continue;

      if (allowedNames && allowedNames.has(name)) {
        filtered.push(tool);
        continue;
      }

      let toolInstance: any;
      try {
        toolInstance = await toolRegistry.getTool(name);
      } catch {
        continue;
      }

      const category = String(toolInstance?.metadata?.category || '').trim();
      if (allowedCategories && category && allowedCategories.has(category)) {
        filtered.push(tool);
      }
    }

    return { tools: filtered };
  }

  // --------------------------------------------------------------------------
  // WebSocket event emission
  // --------------------------------------------------------------------------

  async emitToolCallEvent(
    state: BaseThreadState,
    toolRunId: string,
    toolName: string,
    args: Record<string, any>,
    kind?: string,
  ): Promise<boolean> {
    const connectionId = (state.metadata.wsChannel) || DEFAULT_WS_CHANNEL;
    const sent = await this.dispatchToWebSocket(connectionId, {
      type: 'progress',
      data: {
        phase:     'tool_call',
        toolRunId,
        toolName,
        args,
        kind,
        thread_id: state.metadata.threadId,
      },
      timestamp: Date.now(),
    });

    // Mirror to parent channel so subconscious tool calls appear in the UI
    const parentChannel = (state.metadata as any).parentWsChannel;
    if (parentChannel) {
      const parentThreadId = (state.metadata as any).parentConversationId || state.metadata.threadId;
      await this.dispatchToWebSocket(parentChannel, {
        type: 'progress',
        data: {
          phase:     'tool_call',
          toolRunId,
          toolName,
          args,
          kind,
          thread_id: parentThreadId,
        },
        timestamp: Date.now(),
      });
    }

    return sent;
  }

  async emitToolResultEvent(
    state: BaseThreadState,
    toolRunId: string,
    success: boolean,
    error?: string,
    result?: any,
  ): Promise<boolean> {
    const connectionId = (state.metadata.wsChannel) || DEFAULT_WS_CHANNEL;
    const sent = await this.dispatchToWebSocket(connectionId, {
      type: 'progress',
      data: {
        phase:     'tool_result',
        toolRunId,
        success,
        error,
        result,
        thread_id: state.metadata.threadId,
      },
      timestamp: Date.now(),
    });

    // Mirror to parent channel so subconscious tool results appear in the UI
    const parentChannel = (state.metadata as any).parentWsChannel;
    if (parentChannel) {
      const parentThreadId = (state.metadata as any).parentConversationId || state.metadata.threadId;
      await this.dispatchToWebSocket(parentChannel, {
        type: 'progress',
        data: {
          phase:     'tool_result',
          toolRunId,
          success,
          error,
          result,
          thread_id: parentThreadId,
        },
        timestamp: Date.now(),
      });
    }

    return sent;
  }

  // --------------------------------------------------------------------------
  // Result formatting & state persistence
  // --------------------------------------------------------------------------

  async appendToolResultMessage(
    state: BaseThreadState,
    action: string,
    result: ToolResult,
  ): Promise<void> {
    if (action === 'emit_chat_message') return;

    const formatPayload = (payload: unknown, maxLen?: number): string => {
      if (payload == null) return 'null';

      let parsed = payload;
      if (typeof parsed === 'string') {
        const trimmed = parsed.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          try { parsed = JSON.parse(trimmed); } catch { /* keep as string */ }
        }
      }

      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const record = parsed as Record<string, any>;
        if ('result' in record && ('toolName' in record || 'tool' in record || 'success' in record || 'toolCallId' in record)) {
          parsed = record.result;
        }
      }

      const serialized = typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2);
      if (maxLen && serialized.length > maxLen) {
        return `${ serialized.substring(0, maxLen) }...`;
      }
      return serialized;
    };

    const contentText = formatPayload(result.result, 5000);
    const errorText = String(result.error || 'unknown error').trim();
    const showDetails = contentText.trim().length > 0 && contentText.trim() !== errorText;

    const resultContent = result.success
      ? `tool: ${ action }\nresult:\n${ contentText }`
      : `tool: ${ action }\nerror: ${ errorText }${ showDetails ? `\nresult:\n${ contentText }` : '' }`;

    const toolCallId = result.toolCallId || `${ action }_${ Date.now() }`;

    // Check if the tool result contains a screenshot (from visual tools)
    const toolResult = result.result as any;
    const screenshotBase64 = toolResult?.screenshotBase64
      || toolResult?.result?.screenshotBase64;
    const screenshotMediaType = toolResult?.screenshotMediaType
      || toolResult?.result?.screenshotMediaType
      || 'image/jpeg';

    // 1. Node run context (current LLM turn visibility) — text only
    if (this.ctx.currentNodeRunContext) {
      this.ctx.currentNodeRunContext.messages.push({
        role:         'tool',
        content:      resultContent,
        name:         action,
        tool_call_id: toolCallId,
        metadata:     {
          nodeId:    this.ctx.nodeId,
          nodeName:  this.ctx.nodeName,
          kind:      'tool_result',
          toolName:  action,
          success:   result.success,
          timestamp: Date.now(),
        },
      } as ChatMessage);
    }

    // 2. Persist to state.messages as native tool_result (user role)
    // When a screenshot is present, include it as an image content block
    // so the LLM can see the page visually.
    let toolResultContent: string | any[];
    if (screenshotBase64) {
      toolResultContent = [
        { type: 'image', source: { type: 'base64', media_type: screenshotMediaType, data: screenshotBase64 } },
        { type: 'text', text: resultContent },
      ];
    } else {
      toolResultContent = resultContent;
    }

    const newToolResultBlock = {
      type:        'tool_result',
      tool_use_id: toolCallId,
      content:     toolResultContent,
    };

    const lastMsg = state.messages[state.messages.length - 1];
    const secondToLast = state.messages.length >= 2 ? state.messages[state.messages.length - 2] : null;

    const lastIsToolResult = lastMsg?.role === 'user' &&
      Array.isArray(lastMsg.content) &&
      lastMsg.content.some((b: any) => b?.type === 'tool_result');

    const prevAssistantHasOurToolUse = secondToLast?.role === 'assistant' &&
      Array.isArray(secondToLast.content) &&
      secondToLast.content.some((b: any) => b?.type === 'tool_use' && b?.id === toolCallId);

    if (lastIsToolResult && prevAssistantHasOurToolUse) {
      (lastMsg.content as unknown as any[]).push(newToolResultBlock);
    } else {
      state.messages.push({
        role:     'user',
        content:  [newToolResultBlock],
        metadata: {
          nodeId:    this.ctx.nodeId,
          nodeName:  this.ctx.nodeName,
          kind:      'tool_result',
          toolName:  action,
          success:   result.success,
          timestamp: Date.now(),
        },
      } as any);
    }

    this.ctx.bumpStateVersion(state);

    // Training data: capture tool result
    try {
      const trainingConvId = (state as any).metadata?.conversationId;
      if (trainingConvId) {
        const { getTrainingDataLogger } = require('../services/TrainingDataLogger');
        const tl = getTrainingDataLogger();
        if (tl.hasSession(trainingConvId)) {
          tl.logToolResult(trainingConvId, toolCallId, resultContent);
        }
      }
    } catch { /* best-effort */ }
  }

  // --------------------------------------------------------------------------
  // Training data
  // --------------------------------------------------------------------------

  logTrainingTurn(
    state: BaseThreadState,
    runCtx: NodeRunContext,
    reply: NormalizedResponse,
  ): void {
    try {
      const convId = (state as any).metadata?.conversationId;
      if (!convId) return;

      const { getTrainingDataLogger } = require('../services/TrainingDataLogger');
      const tl = getTrainingDataLogger();
      if (!tl.hasSession(convId)) return;

      const lastUser = [...runCtx.messages].reverse().find((m: ChatMessage) =>
        m.role === 'user' && !(m.metadata as any)?._conversationSummary,
      );
      if (lastUser?.content) {
        const content = typeof lastUser.content === 'string'
          ? lastUser.content
          : JSON.stringify(lastUser.content);
        tl.logUserMessage(convId, content);
      }

      const reasoning = reply.metadata.reasoning || undefined;
      const toolCalls = reply.metadata.tool_calls || [];
      const cleanedContent = stripProtocolTags(reply.content);

      if (toolCalls.length > 0) {
        tl.logToolCall(
          convId,
          toolCalls.map((tc: { id?: string; name: string; args: any }) => ({
            id:   tc.id || `tc_${ Date.now() }_${ Math.random().toString(36).slice(2, 6) }`,
            name: tc.name,
            args: tc.args,
          })),
          cleanedContent || null,
          { reasoning },
        );
      } else if (cleanedContent) {
        tl.logAssistantMessage(convId, cleanedContent, { reasoning });
      }
    } catch { /* best-effort — never block conversation */ }
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private async dispatchToWebSocket(connectionId: string, message: unknown): Promise<boolean> {
    const wsService = getWebSocketClientService();
    return await wsService.send(connectionId, message);
  }

  private persistStructuredToolRunRecord(
    state: BaseThreadState,
    payload: {
      toolName:  string;
      toolRunId: string;
      args:      unknown;
      success:   boolean;
      result?:   unknown;
      error?:    string;
    },
  ): void {
    const metadataAny = state.metadata as any;
    const dedupeKey = this.buildToolRunDedupeKey(payload.toolName, payload.args);
    const record = {
      toolName:  payload.toolName,
      toolRunId: payload.toolRunId,
      dedupeKey,
      args:      payload.args ?? {},
      success:   payload.success,
      result:    payload.result,
      error:     payload.error,
      timestamp: Date.now(),
      nodeId:    this.ctx.nodeId,
      nodeName:  this.ctx.nodeName,
    };

    if (!Array.isArray(metadataAny.__toolRuns)) {
      metadataAny.__toolRuns = [];
    }
    if (!metadataAny.__toolRunIndex || typeof metadataAny.__toolRunIndex !== 'object') {
      metadataAny.__toolRunIndex = {};
    }
    metadataAny.__toolRuns.push(record);
    metadataAny.__toolRunIndex[dedupeKey] = record;
    this.ctx.bumpStateVersion(state);
  }

  private buildToolRunDedupeKey(toolName: string, args: unknown): string {
    return `${ toolName }:${ this.stableStringify(args ?? {}) }`;
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

  private pushToTranscript(toolName: string, success: boolean, error?: string, result?: unknown): void {
    if (this.ctx.currentNodeRunContext) {
      this.ctx.currentNodeRunContext.toolTranscript.push({
        toolName,
        success,
        ...(result !== undefined && { result }),
        ...(error && { error }),
      });
    }
  }
}

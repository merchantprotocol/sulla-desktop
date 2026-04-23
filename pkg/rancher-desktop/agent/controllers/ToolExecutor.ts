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

import { throwIfAborted } from '../services/AbortService';
import { getWebSocketClientService } from '../services/WebSocketClientService';
import { BaseTool } from '../tools/base';
import { toolRegistry } from '../tools/registry';
import { stripProtocolTags } from '../utils/stripProtocolTags';

import type { NormalizedResponse, ChatMessage } from '../languagemodels/BaseLanguageModel';
import type { NodeRunContext } from '../nodes/BaseNode';
import type { BaseThreadState } from '../nodes/Graph';
import type { ToolResult } from '../types';

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_WS_CHANNEL = 'heartbeat';

// Cap inline screenshot base64 at this size before we embed it as an image
// content block in state.messages. Oversize images are dropped (we fall back
// to text-only tool_result) because they blow up Redis state, JSONL logs,
// and the renderer's WebSocket payload. Tools should persist screenshots to
// disk via screenshot_store.saveScreenshot and return a compact reference
// instead of inlining base64 — this cap is a safety net for any tool that
// slips through that pattern.
const MAX_INLINE_SCREENSHOT_BYTES = 500_000;

// Cap the serialized size of a tool result before we ship it over the WebSocket
// to the renderer. Any tool that returns a huge payload (full DOM snapshot,
// raw HTML, base64 blob, etc.) gets replaced with a compact truncation
// placeholder. Protects the chat window's V8 heap, the WS pipe, and the
// renderer-side reactive state regardless of which tool was invoked.
const MAX_TOOL_RESULT_WIRE_BYTES = 50_000;

function capWireResult(r: any): any {
  if (r == null) return r;
  try {
    const serialized = typeof r === 'string' ? r : JSON.stringify(r);
    if (serialized.length <= MAX_TOOL_RESULT_WIRE_BYTES) return r;
    const preview = serialized.slice(0, MAX_TOOL_RESULT_WIRE_BYTES);
    return {
      _truncated:     true,
      _originalBytes: serialized.length,
      _preview:       `${ preview }\n\n[truncated ${ serialized.length - MAX_TOOL_RESULT_WIRE_BYTES } bytes — full payload was ${ serialized.length } bytes total]`,
    };
  } catch {
    return r;
  }
}

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
    state.metadata.lastActivityMs = Date.now();
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
          // Long-running tools (scrape, LLM-heavy sub-calls) can take a
          // while — bump activity on return so the watchdog doesn't
          // mistake legitimate tool wait for an idle agent.
          state.metadata.lastActivityMs = Date.now();
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

          this.trackFailureSignature(state, toolName, toolSuccess, toolError, result);

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

          this.trackFailureSignature(state, toolName, false, error, null);

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

    // Mirror to the workflow's orchestrator channel as a workflow_execution_
    // event so the routine canvas (AgentRoutines.vue) can render tool calls
    // on the emitting node's card, next to its thinking bubbles. Without
    // this a sub-agent would go "quiet" in the routine console during tool
    // work — visible only on its own (unsubscribed) channel.
    const workflowParentChannel = (state.metadata as any).workflowParentChannel;
    const workflowNodeId = (state.metadata as any).workflowNodeId;
    if (workflowParentChannel && workflowNodeId) {
      await this.dispatchToWebSocket(workflowParentChannel, {
        type: 'workflow_execution_event',
        data: {
          type:      'node_tool_call',
          nodeId:    workflowNodeId,
          toolRunId,
          toolName,
          args,
          timestamp: new Date().toISOString(),
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
    const cappedResult = capWireResult(result);
    const sent = await this.dispatchToWebSocket(connectionId, {
      type: 'progress',
      data: {
        phase:     'tool_result',
        toolRunId,
        success,
        error,
        result:    cappedResult,
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
          result:    cappedResult,
          thread_id: parentThreadId,
        },
        timestamp: Date.now(),
      });

    }

    // Workflow-orchestrator mirror — pairs with the tool_call emit above.
    // AgentRoutines.vue renders these as stream lines and pushes them into
    // the node's turn log for the output drawer. Keep the payload slim:
    // the full result already went through the sub-agent's own channel and
    // state.messages; the routine view just needs enough to label the card.
    const workflowParentChannel = (state.metadata as any).workflowParentChannel;
    const workflowNodeId = (state.metadata as any).workflowNodeId;
    if (workflowParentChannel && workflowNodeId) {
      await this.dispatchToWebSocket(workflowParentChannel, {
        type: 'workflow_execution_event',
        data: {
          type:      'node_tool_result',
          nodeId:    workflowNodeId,
          toolRunId,
          success,
          error,
          timestamp: new Date().toISOString(),
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
          try { parsed = JSON.parse(trimmed) } catch { /* keep as string */ }
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
    const screenshotBase64 = toolResult?.screenshotBase64 ||
      toolResult?.result?.screenshotBase64;
    const screenshotMediaType = toolResult?.screenshotMediaType ||
      toolResult?.result?.screenshotMediaType ||
      'image/jpeg';

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

    // 2. Persist to state.messages as native tool_result (user role).
    // When a screenshot is present AND under the size cap, include it as an
    // image content block so the LLM can see the page visually. Oversize
    // screenshots fall back to text-only — the preferred path is for tools
    // to saveScreenshot to disk and return a compact reference that the
    // agent can Read on demand.
    let toolResultContent: string | any[];
    if (screenshotBase64 && screenshotBase64.length <= MAX_INLINE_SCREENSHOT_BYTES) {
      toolResultContent = [
        { type: 'image', source: { type: 'base64', media_type: screenshotMediaType, data: screenshotBase64 } },
        { type: 'text', text: resultContent },
      ];
    } else if (screenshotBase64) {
      console.warn(`[ToolExecutor] Dropped inline screenshot (${ screenshotBase64.length } bytes > ${ MAX_INLINE_SCREENSHOT_BYTES } cap) for tool "${ action }" — tool should use screenshot_store.saveScreenshot and return a path reference`);
      toolResultContent = `${ resultContent }\n\n[screenshot dropped: ${ screenshotBase64.length } bytes exceeds inline cap; tool should return a path reference instead]`;
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
  }

  /**
   * Training data logging — removed (local training code removed).
   * Kept as no-op stub because BaseNode.ts calls this method.
   */
  logTrainingTurn(
    _state: BaseThreadState,
    _runCtx: NodeRunContext,
    _reply: NormalizedResponse,
  ): void {
    // no-op
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

  /**
   * Track repeated failure signatures across tool calls and inject a
   * forceful course-correction message when the same error hits 3×
   * consecutively.
   *
   * Why: pure same-tool-same-args dedupe (LOOP_THRESHOLD above) misses the
   * common failure where the LLM invents a CLI subcommand name (e.g.
   * `sulla browser/action`) and retries it via `exec` with different
   * selectors/payloads every time — the args differ so the dedupe doesn't
   * fire, but the inner error is identical on every attempt. This tracker
   * looks at the ERROR shape of the last N results, catches the loop, and
   * drops a directive hint into the conversation with "Did you mean?"
   * suggestions pulled from the real registry. Fires once per thread to
   * avoid spamming the transcript when the model already got the message.
   */
  private trackFailureSignature(
    state: BaseThreadState,
    toolName: string,
    success: boolean,
    error: string | undefined,
    result: unknown,
  ): void {
    const THRESHOLD = 3;
    const metadataAny = state.metadata as any;

    const signature = this.extractFailureSignature(success, error, result);
    if (!signature) {
      // A successful call clears the streak — otherwise a mix of successes
      // and the same intermittent failure would eventually look like a
      // loop to this tracker.
      metadataAny.__lastFailureSignatures = [];
      return;
    }

    const sigs: string[] = Array.isArray(metadataAny.__lastFailureSignatures)
      ? metadataAny.__lastFailureSignatures
      : (metadataAny.__lastFailureSignatures = []);
    sigs.push(signature);
    if (sigs.length > 5) sigs.shift();

    if (sigs.length < THRESHOLD) return;
    const tail = sigs.slice(-THRESHOLD);
    if (!tail.every(s => s === signature)) return;

    // Fire at most once per signature per thread — if the agent hits a new
    // distinct failure loop later with a different signature, it still
    // gets a hint. Without this scope the flag would mask later loops.
    const fired: Record<string, boolean> = metadataAny.__loopBreakerFired &&
      typeof metadataAny.__loopBreakerFired === 'object'
      ? metadataAny.__loopBreakerFired
      : (metadataAny.__loopBreakerFired = {});
    if (fired[signature]) return;
    fired[signature] = true;

    this.injectLoopBreakerHint(state, toolName, signature);
  }

  /**
   * Extract a normalized failure "shape" from a tool result so repeated
   * failures cluster to the same signature. Two layers:
   *   1. Direct tool failure — `result.error` or `toolError`
   *   2. `exec`-style wrapper — the command succeeded shelling out, but
   *      stdout contains `{"success":false,"error":"..."}`; the real
   *      failure is inside that JSON string.
   * Returns null for anything that can't be interpreted as a failure.
   */
  private extractFailureSignature(
    success: boolean,
    error: string | undefined,
    result: unknown,
  ): string | null {
    const normalize = (err: string): string => {
      // "Internal tool \"X\" or \"Y\" not found" → not_found:X — collapses
      // every variation of the fake-name attempt into one bucket.
      const m = err.match(/Internal tool "([^"]+)"(?:\s+or\s+"[^"]+")?\s+not found/);
      if (m) return `not_found:${ m[1] }`;
      return err.trim().slice(0, 120);
    };

    if (!success && error) return normalize(error);

    if (success && result && typeof result === 'object') {
      const r = result as { result?: unknown };
      const inner = typeof r.result === 'string' ? r.result : null;
      if (inner && inner.includes('"success":false')) {
        try {
          const parsed = JSON.parse(inner);
          if (parsed && parsed.success === false && typeof parsed.error === 'string') {
            return normalize(parsed.error);
          }
        } catch { /* not JSON — fall through */ }
        // Even without clean JSON, a substring match on the not-found
        // pattern is worth catching.
        const m = inner.match(/Internal tool \\?"([^"\\]+)\\?"(?:\s+or\s+\\?"[^"\\]+\\?")?\s+not found/);
        if (m) return `not_found:${ m[1] }`;
      }
    }

    return null;
  }

  /**
   * Append a directive message nudging the agent out of a failure loop.
   * When the signature is `not_found:X`, ask the registry for the closest
   * real tool names so the hint carries concrete alternatives rather than
   * a generic "try something else". For non-not-found loops, tell the
   * agent to stop and call `browse_tools`.
   */
  private injectLoopBreakerHint(
    state: BaseThreadState,
    toolName: string,
    signature: string,
  ): void {
    let content: string;
    if (signature.startsWith('not_found:')) {
      const fakeName = signature.slice('not_found:'.length);
      const suggestions = toolRegistry.findSimilarToolNames(fakeName, 3);
      const didYouMean = suggestions.length
        ? ` Did you mean: ${ suggestions.join(', ') }?`
        : '';
      content = `[loop breaker] You've tried \`${ fakeName }\` three times and it doesn't exist — the Sulla CLI has no such tool.${ didYouMean } Stop retrying \`${ fakeName }\`. If you need the full catalog, call \`browse_tools\` (or \`sulla meta/browse_tools\`) and pick an actual entry from the returned list. Do not invent tool names.`;
    } else {
      content = `[loop breaker] The last three \`${ toolName }\` calls have all failed with the same error. Stop retrying — the repeated attempt will not succeed. Call \`browse_tools\` to review the real tool catalog, then try a different approach. If the task cannot be accomplished with the available tools, report that back and stop.`;
    }

    state.messages.push({ role: 'user', content });
    console.warn(`[ToolExecutor] Loop breaker fired — signature="${ signature }", tool="${ toolName }"`);
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

// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { stripProtocolTags } from '@pkg/agent/utils/stripProtocolTags';
import { logVoiceSpan } from '@pkg/agent/utils/voiceTurn';

import type { DesktopRelayConversationOutbox } from './DesktopRelayConversationOutbox';
import type { DesktopRelayAgentChannel, DesktopRelayChatPorts, DesktopRelayLog } from './DesktopRelayPorts';
import type { DesktopRelayTurnScribe } from './DesktopRelayTurnScribe';

// Local WebSocket channel that BackendGraphWebSocketService watches for
// mobile-originated chats. Must match the constant in that file.
export const MOBILE_RELAY_CHANNEL = 'mobile-relay';

const RICH_CARD_KINDS: readonly string[] = ['tool_question', 'tool_approval', 'citation', 'file_patch', 'proactive', 'workflow_document', 'sub_agent_activity', 'html', 'tool'];

interface AgentChannelMessage { type: string; data?: unknown }

/**
 * Translates what the agent emits on the local `mobile-relay` channel
 * (streaming tokens, activity, committed assistant text, tool cards, graph
 * completion) into the frames mobile understands, scribing every committed
 * turn before it is sent.
 *
 * - `assistant_message kind=streaming` carries the agent's accumulated buffer
 *   each tick; mobile replaces its streamBuffer with each `chunk` delta, so
 *   the full snapshot is shipped.
 * - `kind=thinking` is activity (tool use, reasoning) → `activity`.
 * - `kind=progress` (the default) is the authoritative text for one loop
 *   iteration → committed as its own `message`.
 * - `transfer_data content='graph_execution_complete'` is the real end of the
 *   run → `done`. Emitting `done` earlier closes the mobile socket mid-turn.
 *
 * Frames are processed in order per thread, so a slow scribe cannot let
 * `done` overtake a segment or stall other chats.
 */
export class DesktopRelayAgentBridge {
  private bridged = false;
  // Per-thread state, keyed by thread_id so two simultaneous mobile
  // conversations don't corrupt each other.
  private readonly streamedByThread = new Map<string, string>();
  private readonly finalTextByThread = new Map<string, string>();
  private readonly lastActivityByThread = new Map<string, string>();
  // Id of the most recent committed assistant turn, so `done` can reuse it
  // instead of making mobile persist the same text under a second id.
  private readonly lastCommittedIdByThread = new Map<string, string>();
  private readonly graphOutcome = new Map<string, string>();
  private readonly commitFailed = new Set<string>();
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly channel: () => DesktopRelayAgentChannel,
    private readonly outbox: DesktopRelayConversationOutbox,
    private readonly scribe: DesktopRelayTurnScribe,
    private readonly cards: Pick<DesktopRelayChatPorts, 'registerMobileCard'>,
    private readonly deviceId: () => Promise<string>,
    private readonly log: DesktopRelayLog,
  ) {}

  /** Install the one-time subscription to the mobile-relay channel. Idempotent. */
  ensureBridged(): void {
    if (this.bridged) return;
    this.bridged = true;
    const channel = this.channel();
    channel.connect(MOBILE_RELAY_CHANNEL);
    channel.onMessage(MOBILE_RELAY_CHANNEL, message => this.enqueue(message));
  }

  private enqueue(msg: AgentChannelMessage): Promise<void> {
    const threadId = typeof (msg.data as any)?.thread_id === 'string' ? (msg.data as any).thread_id : '';
    const next = (this.queues.get(threadId) ?? Promise.resolve()).then(() => this.handle(msg));
    const settled = next.catch((error) => {
      if (threadId && this.outbox.activeRun(threadId)) this.commitFailed.add(threadId);
      this.log.warn('[DesktopRelay] Mobile bridge frame failed:', error);
    });
    this.queues.set(threadId, settled);
    settled.then(() => { if (this.queues.get(threadId) === settled) this.queues.delete(threadId); });
    return settled;
  }

  private async handle(msg: AgentChannelMessage): Promise<void> {
    const threadId = (msg.data as any)?.thread_id;
    if (typeof threadId !== 'string' || !this.outbox.activeRun(threadId)) return;
    if (msg.type === 'relay_dispatch_complete') {
      const data = msg.data as { relayRunId?: string; outcome?: string };
      if (data.relayRunId !== this.outbox.activeRun(threadId)) return;
      return this.finish(threadId, data.outcome === 'accepted' ? this.graphOutcome.get(threadId) || 'completed' : data.outcome || 'failed');
    }
    if (msg.type === 'speak_dispatch') return this.handleSpeak(msg.data);
    if (msg.type === 'progress') return this.handleToolProgress(msg.data);
    if (msg.type === 'assistant_message') return this.handleAssistantMessage(msg.data);
    if (msg.type === 'transfer_data') return this.handleTransferData(msg.data);
    // thread_created: mobile uses its own conversationId scheme; nothing to plumb back.
  }

  /**
   * Commit one finished text segment as its own assistant turn. Scribe before
   * the WS send; the id is derived here so mobile persists under this SAME id.
   * `spoken` marks a <speak> sentence mobile reads aloud on arrival.
   */
  private async commitAssistantText(threadId: string, text: string, spoken = false): Promise<void> {
    const ts = new Date().toISOString();
    const id = this.scribe.deriveId(threadId, 'assistant', text, ts);
    await this.scribe.scribe(threadId, 'assistant', text, { id, ts });
    this.lastActivityByThread.delete(threadId);
    this.finalTextByThread.set(threadId, text);
    this.streamedByThread.delete(threadId);
    this.lastCommittedIdByThread.set(threadId, id);
    this.outbox.sendChatFrame(threadId, { type: 'message', content: text, id, ...(spoken ? { spoken: true } : {}) });
  }

  private async sendCard(threadId: string, card: Record<string, unknown>): Promise<void> {
    const content = JSON.stringify({ sullaCard: card });
    const id = await this.scribe.scribeDerived(threadId, 'tool', content);
    this.outbox.sendChatFrame(threadId, { type: 'card', content, id });
  }

  private async handleSpeak(raw: unknown): Promise<void> {
    const data = (raw && typeof raw === 'object') ? (raw as any) : {};
    const threadId = typeof data.thread_id === 'string' ? data.thread_id : '';
    const text = typeof data.text === 'string' ? data.text.trim() : '';
    if (threadId && text) {
      await this.commitAssistantText(threadId, text, true);
      logVoiceSpan(data.voiceTurnId, 'desktop.speak_relayed', { size: text.length });
    }
  }

  private async handleToolProgress(raw: unknown): Promise<void> {
    const data = (raw || {}) as any;
    const threadId = typeof data.thread_id === 'string' ? data.thread_id : '';
    if (!threadId || !['tool_call', 'tool_result'].includes(data.phase)) return;
    await this.sendCard(threadId, { version: 1, kind: 'tool', deviceId: await this.deviceId(), toolCard: {
      toolName: data.toolName || 'Tool', status: data.phase === 'tool_call' ? 'running' : data.success === false ? 'failed' : 'success',
      args: data.args, result: data.result, error: data.error,
    } });
  }

  private async handleAssistantMessage(raw: unknown): Promise<void> {
    const data = (raw && typeof raw === 'object') ? (raw as any) : {};
    const kind = typeof data.kind === 'string' ? data.kind : '';
    const threadId = typeof data.thread_id === 'string' ? data.thread_id : '';
    if (threadId && RICH_CARD_KINDS.includes(kind)) {
      await this.cards.registerMobileCard(threadId, kind, data);
      // Persist a versioned envelope through the existing durable history path.
      // Never serialize arbitrary event metadata, tokens or execution context.
      await this.sendCard(threadId, { version: 1, kind, deviceId: await this.deviceId(), content: data.content || '',
        toolQuestion: data.toolQuestion, toolApproval: data.toolApproval, citations: data.citations,
        filePatch: data.filePatch, workflow: data.workflow, headline: data.headline, body: data.body,
        toolCard: data.toolCard, subAgentActivity: data.subAgentActivity });
      return;
    }
    if (kind === 'streaming_complete') {
      // Segment boundary: commit the segment now. Streaming-only providers
      // never send a `progress` for these, so without this only the run's
      // last segment ever reached mobile's thread.
      const segment = threadId ? this.streamedByThread.get(threadId) : undefined;
      if (threadId && segment) await this.commitAssistantText(threadId, segment);
      return;
    }
    const content = typeof data.content === 'string' ? data.content : '';
    if (!content) return;
    if (!threadId) {
      this.log.warn(`[DesktopRelay] Dropping ${ kind || 'assistant' } frame without thread_id/conversationId`);
      return;
    }
    // Defense-in-depth: a final strip guarantees no protocol wrapper slips through.
    const stripped = stripProtocolTags(content);
    if (!stripped) return;

    if (kind === 'thinking') {
      // Tool-use / reasoning indicator. De-dup consecutive duplicates, and
      // scribe it so history shows what the agent did, not just what it said.
      if (stripped === this.lastActivityByThread.get(threadId)) return;
      this.lastActivityByThread.set(threadId, stripped);
      await this.scribe.scribe(threadId, 'tool', stripped);
      this.outbox.sendChatFrame(threadId, { type: 'activity', message: stripped });
      return;
    }
    if (kind === 'streaming') {
      // Ship the full snapshot in `delta`; mobile replaces its buffer each tick.
      const prev = this.streamedByThread.get(threadId) ?? '';
      if (stripped === prev) return; // no-op tick
      this.streamedByThread.set(threadId, stripped);
      this.outbox.sendChatFrame(threadId, { type: 'chunk', delta: stripped });
      return;
    }
    if (kind === 'progress' || kind === '') {
      // Authoritative text for this iteration, committed immediately. Skip it
      // when the same text was already committed at its streaming_complete boundary.
      if (stripped.trim() === this.finalTextByThread.get(threadId)?.trim()) {
        this.streamedByThread.delete(threadId);
        return;
      }
      await this.commitAssistantText(threadId, stripped);
    }
    // Any other kind (e.g. thinking_complete) — intentionally ignored.
  }

  private async handleTransferData(raw: unknown): Promise<void> {
    const data = (raw && typeof raw === 'object') ? (raw as any) : {};
    const content = typeof data.content === 'string' ? data.content : '';
    if (content !== 'graph_execution_complete') return;
    const threadId = typeof data.thread_id === 'string' ? data.thread_id : '';
    if (!threadId) {
      this.log.warn('[DesktopRelay] Dropping done frame without thread_id/conversationId');
      return;
    }
    this.graphOutcome.set(threadId, typeof data.stopReason === 'string' ? data.stopReason : 'completed');
  }

  private async finish(threadId: string, outcome: string): Promise<void> {
    const runId = this.outbox.activeRun(threadId);
    if (!runId) return;
    let terminal: Record<string, unknown>;
    try {
      // A failed turn write is not completed live. The existing history
      // store remains the only source for recovery.
      if (this.commitFailed.has(threadId)) throw new Error('relay_history_unavailable');
      const trailing = this.streamedByThread.get(threadId);
      if (outcome !== 'stopped' && trailing) await this.commitAssistantText(threadId, trailing);
      const finalText = this.finalTextByThread.get(threadId) ?? '';
      const id = this.lastCommittedIdByThread.get(threadId);
      await this.scribe.scribeDerived(threadId, 'tool', JSON.stringify({
        sullaCard: { version: 1, kind: 'run_outcome', runId, outcome },
      }));
      terminal = outcome === 'stopped'
        ? { type: 'stopped', outcome }
        : { type: 'done', content: finalText, id, outcome };
    } catch {
      terminal = { type: 'error', reason: 'relay_history_unavailable' };
    }
    this.streamedByThread.delete(threadId);
    this.finalTextByThread.delete(threadId);
    this.lastActivityByThread.delete(threadId);
    this.lastCommittedIdByThread.delete(threadId);
    this.graphOutcome.delete(threadId);
    this.commitFailed.delete(threadId);
    this.outbox.completeRun(threadId, terminal);
  }
}

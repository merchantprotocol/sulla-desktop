// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { logVoiceSpan, voiceTurnRoute } from '@pkg/agent/utils/voiceTurn';
import { describeTurnForAgent, normalizeMobileContent, transcriptText, type NormalizedMobileTurn } from '@pkg/main/mobileRelayContent';

import { MOBILE_RELAY_CHANNEL, type DesktopRelayAgentBridge } from './DesktopRelayAgentBridge';
import type { DesktopRelayConversationOutbox } from './DesktopRelayConversationOutbox';
import type { DesktopRelayAgentChannel, DesktopRelayChatPorts, DesktopRelayLog, RelayFrameSink, RelayIncomingFrame } from './DesktopRelayPorts';
import type { DesktopRelayTurnScribe } from './DesktopRelayTurnScribe';

/** The desktop identity the handlers stamp on cards; resolved lazily for secure-channel commands. */
export interface DesktopRelayIdentity {
  deviceId: string;
}

/**
 * Handles mobile chat, inject, cancel and companion requests, from the relay
 * room or the secure desktop channel. The relay is a pure bridge: a chat
 * becomes a `user_message` on the local `mobile-relay` channel and runs
 * through the normal agent loop (same AgentNode, strip and tools).
 */
export class DesktopRelayRequestHandlers {
  constructor(
    private readonly identity: DesktopRelayIdentity,
    private readonly resolveDeviceId: () => Promise<string>,
    private readonly outbox: DesktopRelayConversationOutbox,
    private readonly bridge: DesktopRelayAgentBridge,
    private readonly scribe: DesktopRelayTurnScribe,
    private readonly channel: () => DesktopRelayAgentChannel,
    private readonly chat: DesktopRelayChatPorts,
    private readonly log: DesktopRelayLog,
  ) {}

  /**
   * Entry point for commands that arrived over the secure desktop channel and
   * were already verified by secureChannel.ts. `reply` delivers conversation
   * frames to the client(s) following that conversation; `respond` answers
   * this one request (companion responses, validation errors).
   */
  async handleRemoteCommand(msg: RelayIncomingFrame, reply: RelayFrameSink, respond: RelayFrameSink): Promise<void> {
    if (!this.identity.deviceId) this.identity.deviceId = await this.resolveDeviceId();
    if (msg.type === 'companion_request') {
      if (!msg.requestId) return;
      const threadId = typeof msg.params?.conversationId === 'string' ? msg.params.conversationId : '';
      if (threadId) this.outbox.setSecureRoute(threadId, reply);
      await this.companion(msg, respond);
      return;
    }
    const conversationId = msg.conversationId;
    if (typeof conversationId !== 'string' || !conversationId || conversationId.length > 200) {
      respond({ type: 'error', reason: 'missing_conversation_id', userMessageId: msg.userMessageId });
      return;
    }
    this.outbox.setSecureRoute(conversationId, reply);
    if (msg.type === 'chat') await this.handleChat(msg);
    else if (msg.type === 'cancel') this.handleCancel(msg);
    else if (msg.type === 'inject') await this.handleInject(msg);
  }

  async companion(msg: RelayIncomingFrame, respond: RelayFrameSink): Promise<void> {
    try {
      const result = msg.method === 'chat.runs'
        ? { conversations: this.outbox.activeConversationIds() }
        : await this.chat.companionRequest(msg.method || '', msg.params || {});
      if (msg.method === 'chat.answer' || (msg.method === 'decisions.resolve' && (result as any)?.settled)) {
        const threadId = String(msg.params?.conversationId || '');
        const content = JSON.stringify({ sullaCard: { version: 1, kind: 'decision_result', deviceId: this.identity.deviceId, content: 'Your response was received.', answeredId: msg.params?.id, answers: msg.params?.answers, decision: msg.params?.decision || msg.params?.action } });
        const id = await this.scribe.scribeDerived(threadId, 'tool', content);
        this.outbox.sendChatFrame(threadId, { type: 'card', content, id });
      }
      respond({ type: 'companion_response', requestId: msg.requestId, result });
    } catch (error) {
      respond({ type: 'companion_response', requestId: msg.requestId, error: error instanceof Error ? error.message : 'Request failed' });
    }
  }

  /**
   * Mobile hit the stop button. Publish stop_run on the mobile-relay channel —
   * BackendGraphWebSocketService aborts the active agent run.
   */
  handleCancel(msg: RelayIncomingFrame): void {
    const conversationId = msg.conversationId;
    if (!conversationId) {
      this.log.warn('[DesktopRelay] Rejecting cancel without conversationId');
      this.outbox.sendMissingConversationError(msg.userMessageId);
      return;
    }
    this.log.log(`[DesktopRelay] Cancel received for conversationId=${ conversationId }`);
    this.channel().send(MOBILE_RELAY_CHANNEL, { type: 'stop_run', data: { threadId: conversationId }, timestamp: Date.now() });
    this.outbox.cancelRun(conversationId);
    // Ack so mobile knows the run ended without waiting for `done` (which may
    // never arrive after an abort). This is not a close signal.
    const runId = msg.clientRunId || msg.userMessageId || this.outbox.oldestRun(conversationId);
    this.outbox.sendChatFrame(conversationId, { type: 'stopped', ...(runId ? { clientRunId: runId, userMessageId: runId } : {}) });
  }

  /** Mobile sent a mid-run message: inject it without aborting; the agent picks it up at the next loop boundary. */
  async handleInject(msg: RelayIncomingFrame): Promise<void> {
    const lastUser = (msg.messages ?? []).slice().reverse().find((m: any) => m.role === 'user');
    const turn = normalizeMobileContent(lastUser?.content);
    if (!turn.text && !turn.files.length) return;
    const conversationId = msg.conversationId;
    if (!conversationId) {
      this.log.warn('[DesktopRelay] Rejecting inject without conversationId');
      this.outbox.sendMissingConversationError(msg.userMessageId);
      return;
    }
    this.log.log(`[DesktopRelay] Inject received for conversationId=${ conversationId ?? '(none)' }`);
    const savedPaths = await this.saveAttachments(conversationId, msg.userMessageId, turn);
    const selection = await this.chat.validateSelection(msg);
    // Injected mid-run turns are part of the conversation record too.
    await this.scribe.scribe(conversationId, 'user', transcriptText(turn), { id: msg.userMessageId });
    this.channel().send(MOBILE_RELAY_CHANNEL, {
      type: 'inject_message',
      data: {
        content:  describeTurnForAgent(turn, savedPaths),
        threadId: conversationId,
        metadata: {
          source:      'mobile-relay',
          inputSource: 'keyboard',
          conversationId,
          ...selection,
          ...(turn.images.length ? { attachments: turn.images } : {}),
        },
      },
      timestamp: Date.now(),
    });
  }

  /** Bridge a mobile chat request onto the local agent channel. */
  async handleChat(msg: RelayIncomingFrame): Promise<void> {
    const messages = msg.messages ?? [];
    const conversationId = msg.conversationId;
    this.log.log(`[DesktopRelay] Chat request — ${ messages.length } messages, conversationId=${ conversationId ?? '(none)' }`);
    if (!conversationId) {
      this.log.warn('[DesktopRelay] Rejecting chat without conversationId');
      this.outbox.sendMissingConversationError(msg.userMessageId);
      return;
    }
    if (!msg.userMessageId) {
      this.log.warn(`[DesktopRelay] Rejecting chat for conversationId=${ conversationId } without userMessageId`);
      this.outbox.sendChatFrame(conversationId, { type: 'error', reason: 'missing_user_message_id' });
      return;
    }
    this.outbox.registerRun(conversationId, msg.clientRunId || msg.userMessageId);

    // The agent keeps its own thread state; only the fresh (last) user turn is needed.
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    const turn = normalizeMobileContent(lastUser?.content);
    if (!turn.text && !turn.files.length) {
      this.log.warn('[DesktopRelay] Chat request had no user content; ignoring');
      this.outbox.sendChatFrame(conversationId, { type: 'error', reason: 'empty_user_message', userMessageId: msg.userMessageId });
      return;
    }
    if (await this.scribe.messageExists(msg.userMessageId)) {
      this.log.log(`[DesktopRelay] Duplicate mobile chat ignored — conversationId=${ conversationId }, userMessageId=${ msg.userMessageId }`);
      this.outbox.sendChatFrame(conversationId, { type: 'ack', userMessageId: msg.userMessageId, duplicate: true });
      return;
    }
    this.bridge.ensureBridged();

    // Spoken turns run on the voice agent and its own fast model; only typed
    // turns honour the phone's agent/model picker.
    const voiceRoute = voiceTurnRoute(msg);
    logVoiceSpan(voiceRoute?.voiceTurnId, 'desktop.relay_received');
    const savedPaths = await this.saveAttachments(conversationId, msg.userMessageId, turn);
    const selection = voiceRoute ?? await this.chat.validateSelection(msg);

    // Scribe the user turn FIRST — the sync log is the authoritative record —
    // then ACK so mobile can clear its outbox without a socket-only acknowledgement.
    await this.scribe.scribe(conversationId, 'user', transcriptText(turn), { id: msg.userMessageId });
    this.outbox.sendChatFrame(conversationId, { type: 'ack', userMessageId: msg.userMessageId });

    this.channel().send(MOBILE_RELAY_CHANNEL, {
      type: 'user_message',
      data: {
        content:  describeTurnForAgent(turn, savedPaths),
        threadId: conversationId,
        metadata: {
          source:         'mobile-relay',
          inputSource:    voiceRoute ? 'voice' : 'keyboard',
          conversationId,
          ...selection,
          ...(turn.images.length ? { attachments: turn.images } : {}),
        },
      },
      timestamp: Date.now(),
    });
    // Keep mobile's idle timeout from firing during long tool phases; cleared
    // on graph_execution_complete. Skipped while mobile is offline.
    this.outbox.beginRun(conversationId);
  }

  /** Save phone attachments where agent tools can open them; never throws. */
  private async saveAttachments(conversationId: string, messageId: string | undefined, turn: NormalizedMobileTurn): Promise<string[]> {
    if (!turn.files.length) return [];
    try {
      return await this.chat.persistAttachments(conversationId, messageId || String(Date.now()), turn);
    } catch (err) {
      this.log.warn(`[DesktopRelay] Failed to save mobile attachments for ${ conversationId }:`, err);
      return [];
    }
  }
}

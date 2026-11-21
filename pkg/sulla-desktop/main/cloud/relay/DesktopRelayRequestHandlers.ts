// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { logVoiceSpan, voiceTurnRoute } from '@pkg/agent/utils/voiceTurn';
import { describeTurnForAgent, normalizeMobileContent, transcriptText, type NormalizedMobileTurn } from '@pkg/main/mobileRelayContent';

import { MOBILE_RELAY_CHANNEL, type DesktopRelayAgentBridge } from './DesktopRelayAgentBridge';
import type { DesktopRelayConversationOutbox } from './DesktopRelayConversationOutbox';
import type { DesktopRelayAgentChannel, DesktopRelayChatPorts, DesktopRelayLog, RelayFrameSink, RelayIncomingFrame, ScopedRelayBinding } from './DesktopRelayPorts';
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
  private readonly preparing = new Map<string, { id: string; stopped: boolean }>();
  private readonly claims = new Map<string, { id: string; settled: Promise<void> }>();

  private validId(value: unknown): value is string {
    return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(value);
  }

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
    if (msg.conversationId?.startsWith('remote_') || String(msg.params?.conversationId ?? '').startsWith('remote_')) return;
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
    if (msg.type === 'chat') await this.handleChat(msg, frame => respond({ ...frame, conversationId, deviceId: this.identity.deviceId }));
    else if (msg.type === 'cancel') this.handleCancel(msg);
    else if (msg.type === 'inject') await this.handleInject(msg);
  }

  async companion(msg: RelayIncomingFrame, respond: RelayFrameSink): Promise<void> {
    try {
      const result = msg.method === 'chat.runs'
        ? { conversations: this.outbox.activeConversationIds().filter(id => !id.startsWith('remote_')) }
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

  async handleScopedCommand(msg: RelayIncomingFrame): Promise<void> {
    const thread = msg.conversationId;
    if (!thread || !/^remote_[A-Za-z0-9_-]{12,180}$/.test(thread)
        || !msg.relayRequest || !msg.viewerId || !msg.viewerKey) return;
    const respond: RelayFrameSink = frame => this.outbox.sendScoped(thread, frame, msg.relayRequest);
    const accountId = await this.chat.currentRelayAccount?.();
    const hostDeviceId = await this.resolveDeviceId();
    if (!accountId || msg.accountId !== accountId || !this.validId(msg.workspaceId)
        || !hostDeviceId || msg.targetDeviceId !== hostDeviceId
        || !await this.chat.approveViewer?.(msg.viewerId, msg.viewerKey)) {
      respond({ type: 'error', reason: 'thread_not_authorized', definitelyNotAccepted: true });
      return;
    }
    const scope = { accountId, workspaceId: msg.workspaceId, hostDeviceId };
    if (msg.type === 'relay_admit') {
      if (await this.chat.admitRelayThread?.(thread, false, scope)) respond({ type: 'relay_admitted' });
      else respond({ type: 'error', reason: 'thread_not_authorized' });
    }
    if (msg.type === 'chat') await this.handleChat(msg, respond, scope);
    if (msg.type === 'cancel') {
      if (await this.chat.admitRelayThread?.(thread, true, scope)) this.handleCancel(msg, respond);
      else respond({ type: 'error', reason: 'thread_not_authorized' });
    }
    if (msg.type === 'relay_history_check') {
      const allowed = await this.chat.admitRelayThread?.(thread, true, scope)
        && await this.chat.allowScopedHistory?.()
        && await this.chat.approveViewer?.(msg.viewerId, msg.viewerKey);
      respond({ type: allowed ? 'relay_history_allowed' : 'error', reason: allowed ? undefined : 'thread_not_authorized' });
    }
    if (msg.type === 'relay_subscribe') {
      if (await this.chat.admitRelayThread?.(thread, true, scope)) respond({ type: 'relay_subscribed' });
      else respond({ type: 'error', reason: 'thread_not_authorized' });
    }
  }

  handleCancel(msg: RelayIncomingFrame, respond?: RelayFrameSink): void {
    const conversationId = msg.conversationId;
    const runId = msg.clientRunId || msg.userMessageId;
    if (!conversationId || !runId || this.outbox.activeRun(conversationId) !== runId) {
      respond?.({ type: 'error', reason: 'stale_run', clientRunId: runId });
      return;
    }
    const preparing = this.preparing.get(conversationId);
    if (preparing?.id === runId) preparing.stopped = true;
    else this.channel().send(MOBILE_RELAY_CHANNEL, {
      type: 'stop_run', data: { threadId: conversationId, relayRunId: runId }, timestamp: Date.now(),
    });
    // Request acknowledgment isn't a terminal event. The backend emits the
    // exact run's settled result after its execution has actually unwound.
    respond?.({ type: 'relay_cancel_requested', clientRunId: runId });
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
    const relayRunId = this.outbox.activeRun(conversationId);
    if (!relayRunId) return;
    const selection = await this.chat.validateSelection(msg);
    if (this.outbox.activeRun(conversationId) !== relayRunId) return;
    const savedPaths = await this.saveAttachments(conversationId, msg.userMessageId, turn);
    // Injected mid-run turns are part of the conversation record too.
    await this.scribe.scribe(conversationId, 'user', transcriptText(turn), { id: msg.userMessageId });
    this.channel().send(MOBILE_RELAY_CHANNEL, {
      type: 'inject_message',
      data: {
        content:  describeTurnForAgent(turn, savedPaths),
        threadId: conversationId,
        relayRunId,
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
  async handleChat(msg: RelayIncomingFrame, origin?: RelayFrameSink, scope?: ScopedRelayBinding): Promise<void> {
    const conversationId = msg.conversationId;
    if (!this.validId(conversationId)) {
      this.outbox.sendMissingConversationError(msg.userMessageId);
      return;
    }
    const respond = origin ?? (frame => this.outbox.sendChatFrame(conversationId, frame));
    const id = msg.userMessageId;
    if (!this.validId(id)) {
      respond({ type: 'error', reason: 'missing_user_message_id', ...(scope ? { definitelyNotAccepted: true } : {}) });
      return;
    }
    // Mobile already uses the persisted message ID as its clientRunId. Use
    // that canonical identity even if a retry supplies a different hint.
    const identity = { userMessageId: id, clientRunId: id };
    let enteredCommit = false;
    const error = (reason: string) => respond({
      type: 'error', reason, ...identity, ...(scope && !enteredCommit ? { definitelyNotAccepted: true } : {}),
    });
    const messages = Array.isArray(msg.messages) ? msg.messages : [];
    const turn = normalizeMobileContent([...messages].reverse().find(m => m?.role === 'user')?.content);
    if (!turn.text && !turn.files.length) return error('empty_user_message');

    while (this.claims.has(conversationId)) {
      const claim = this.claims.get(conversationId)!;
      if (claim.id !== id) return error('thread_busy');
      await claim.settled;
    }
    let settle!: () => void;
    const settled = new Promise<void>(resolve => { settle = resolve });
    this.claims.set(conversationId, { id, settled });
    try {
      if (this.chat.admitRelayThread && !await this.chat.admitRelayThread(conversationId, false, scope)) return error('thread_not_authorized');
      const voiceRoute = voiceTurnRoute(msg);
      const selection = voiceRoute ?? await this.chat.validateSelection(msg);
      if (msg.relayScope && (['providerId', 'modelId', 'agentId'] as const).some(key =>
        msg[key] != null && msg[key] !== (selection as Record<string, unknown>)[key])) return error('selection_unavailable');
      // Recheck after asynchronous local admission and selection.
      if (msg.relayScope && (!msg.viewerId || !msg.viewerKey || !await this.chat.approveViewer?.(msg.viewerId, msg.viewerKey))) {
        return error('thread_not_authorized');
      }
      const active = this.outbox.activeRun(conversationId);
      if (active && active !== id) return error('thread_busy');
      enteredCommit = true;
      const acceptance = await this.scribe.acceptUserTurn(conversationId, id, transcriptText(turn), scope);
      if (acceptance === 'conflict') return error('message_identity_conflict');
      if (acceptance === 'duplicate') {
        respond({ type: 'ack', duplicate: true, ...identity });
        return;
      }

      const preparation = { id, stopped: false };
      this.preparing.set(conversationId, preparation);
      this.bridge.ensureBridged();
      this.outbox.registerRun(conversationId, id, scope && msg.viewerId && msg.viewerKey
        ? { ...scope, viewerId: msg.viewerId, viewerKey: msg.viewerKey } : undefined);
      this.outbox.beginRun(conversationId);
      respond({ type: 'ack', ...identity });
      // Attachment writes are effects of the durable claim winner only.
      const savedPaths = await this.saveAttachments(conversationId, id, turn);
      this.preparing.delete(conversationId);
      if (preparation.stopped) {
        this.channel().send(MOBILE_RELAY_CHANNEL, {
          type: 'relay_dispatch_complete', data: { thread_id: conversationId, relayRunId: id, outcome: 'stopped' },
        });
        return;
      }
      logVoiceSpan(voiceRoute?.voiceTurnId, 'desktop.relay_received');
      this.channel().send(MOBILE_RELAY_CHANNEL, {
        type: 'user_message',
        data: {
          content: describeTurnForAgent(turn, savedPaths),
          threadId: conversationId,
          relayRunId: id,
          metadata: {
            source: 'mobile-relay',
            inputSource: voiceRoute ? 'voice' : 'keyboard',
            conversationId,
            ...selection,
            ...(turn.images.length ? { attachments: turn.images } : {}),
          },
        },
        timestamp: Date.now(),
      });
    } catch {
      this.log.warn('[DesktopRelay] Relay turn could not be accepted or dispatched');
      error('acceptance_unavailable');
    } finally {
      this.preparing.delete(conversationId);
      this.claims.delete(conversationId);
      settle();
    }
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

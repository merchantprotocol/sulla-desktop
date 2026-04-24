/*
  PersonaAdapter — bridges the existing ChatInterface (which owns the
  AgentPersonaService, queue, thread-id, and localStorage persistence)
  to the new ChatController.

  Direction of flow:
    • User input: ChatController.send() → adapter.send() → ChatInterface.send()
      → persona.addUserMessage → persona.messages grows → adapter syncs it
      back into ChatController.thread.messages.
    • Backend activity: persona.messages and persona.graphRunning → adapter
      watchers → ChatController.appendMessage/updateMessage + runState.

  The controller's own optimistic append is disabled via `sendHandler`
  so there's no duplication.
*/

import { watch, type WatchStopHandle } from 'vue';

import { ChatInterface, type ChatMessage as BackendMessage } from '../../agent/ChatInterface';
import type { ChatController } from '../controller/ChatController';
import type { Message, UserMessage, SullaMessage, StreamingMessage, ThinkingMessage,
  ToolMessage, ChannelMessage, SubAgentMessage, ErrorMessage, HtmlMessage, InterimMessage,
} from '../models/Message';
import type { Attachment } from '../models/Attachment';
import { asMessageId, newAttachmentId, newMessageId } from '../types/chat';

export interface PersonaAdapterOptions {
  channelId?: string;
  tabId?:     string;
}

export class PersonaAdapter {
  private ci: ChatInterface;
  private stopWatchers: WatchStopHandle[] = [];
  /** Backend ids we've seen (so we don't re-append duplicates on watcher fires). */
  private seen = new Set<string>();

  constructor(
    private readonly controller: ChatController,
    opts: PersonaAdapterOptions = {},
  ) {
    this.ci = new ChatInterface(opts.channelId ?? 'sulla-desktop', opts.tabId);

    // Tell the controller to delegate send/stop/continue to us.
    this.controller.setSendHandler((text, attachments) => this.send(text, attachments));
    this.controller.setRunHandlers({
      onStop:     () => this.ci.stop(),
      onContinue: () => this.ci.continueRun(),
    });

    // Pull in any messages that were already restored from localStorage.
    this.syncMessages();

    // React to persona.messages growing / items being mutated in place.
    this.stopWatchers.push(
      watch(() => this.ci.messages.value, () => this.syncMessages(), { deep: true }),
    );

    // Drive the run-state machine from the backend.
    this.stopWatchers.push(
      watch(() => this.ci.graphRunning.value, (running) => this.syncRunState(running)),
    );

    // showContinueButton goes high on max_loops — mirror into paused(limit).
    this.stopWatchers.push(
      watch(() => this.ci.showContinueButton.value, (show) => {
        if (show) this.controller.transitionRun({ type: 'hitLimit' });
      }),
    );
  }

  // ─── Intents dispatched by the controller ──────────────────────────
  async send(text: string, attachments: Attachment[]): Promise<void> {
    this.ci.query.value = text;
    const mapped = attachments
      .map(a => a.file ? fileToAttachmentInput(a.file) : null)
      .filter(Boolean) as Promise<{ mediaType: string; base64: string }>[];

    const resolved = await Promise.all(mapped);
    await this.ci.send(undefined, resolved.length ? resolved : undefined);
  }

  stop(): void { this.ci.stop(); }
  continueRun(): void { this.ci.continueRun(); }
  newChat(): void { this.ci.newChat(); this.seen.clear(); }

  dispose(): void {
    for (const stop of this.stopWatchers) stop();
    this.stopWatchers = [];
    this.ci.dispose();
  }

  // ─── Sync backend → controller ─────────────────────────────────────
  private syncMessages(): void {
    const backend = this.ci.messages.value;
    for (const b of backend) {
      if (!b?.id) continue;
      const mapped = this.mapBackendMessage(b);
      if (!mapped) continue;
      if (this.seen.has(b.id)) {
        // Existing — update mutable fields (streaming text, tool status, etc.)
        this.controller.updateMessage(mapped.id, mapped as Partial<Message>);
      } else {
        this.seen.add(b.id);
        this.controller.appendMessage(mapped);
      }
    }
  }

  private syncRunState(running: boolean): void {
    const phase = this.controller.runState.value.phase;
    if (running && (phase === 'idle' || phase === 'paused' || phase === 'error')) {
      this.controller.transitionRun({
        type: 'think',
        messageId: newMessageId(),
      });
    }
    if (!running && phase !== 'idle' && phase !== 'paused' && phase !== 'error') {
      // Backend stopped working — collapse back to rest.
      this.controller.transitionRun({ type: 'idle' });
    }
  }

  // ─── Mapping ───────────────────────────────────────────────────────
  private mapBackendMessage(b: BackendMessage): Message | null {
    const id = asMessageId(b.id);
    const createdAt = Date.now();

    // Interim voice transcript
    if (b.kind === 'voice_interim') {
      return { id, kind: 'interim', createdAt, text: b.content ?? '', startedAt: createdAt } satisfies InterimMessage;
    }

    // User turn
    if (b.role === 'user') {
      return {
        id, kind: 'user', createdAt, text: b.content ?? '',
        attachments: b.image ? [{
          id: newAttachmentId(), name: b.image.alt || 'image', size: '', kind: 'image',
        }] : undefined,
      } satisfies UserMessage;
    }

    // Thinking
    if (b.kind === 'thinking') {
      const thoughts = splitThoughts(b.content ?? '');
      const completed = !this.ci.graphRunning.value;
      return {
        id, kind: 'thinking', createdAt,
        thoughts, startedAt: createdAt, completed,
        summary: completed ? firstLineOf(b.content ?? '') : undefined,
      } satisfies ThinkingMessage;
    }

    // Tool card
    if (b.kind === 'tool' && b.toolCard) {
      const status: ToolMessage['status'] =
        b.toolCard.status === 'success' ? 'ok'
        : b.toolCard.status === 'failed' ? 'error'
        : 'running';
      return {
        id, kind: 'tool', createdAt,
        tool: b.toolCard.label || b.toolCard.toolName || 'Tool',
        desc: b.toolCard.summary || b.toolCard.description || '',
        status,
        meta: b.toolCard.outputFormat === 'text'
          ? (typeof b.toolCard.output === 'string' ? truncMiddle(b.toolCard.output, 60) : undefined)
          : undefined,
      } satisfies ToolMessage;
    }

    // Channel message (from Heartbeat/Workbench/Mobile)
    if (b.kind === 'channel_message') {
      return {
        id, kind: 'channel', createdAt,
        agent:   b.channelMeta?.senderId       || 'Agent',
        channel: b.channelMeta?.senderChannel  || '',
        text:    b.content ?? '',
      } satisfies ChannelMessage;
    }

    // Sub-agent activity — phase-0: render as a compact bubble.
    if (b.kind === 'sub_agent_activity') {
      return {
        id, kind: 'subagent', createdAt,
        name: 'sub-agent', desc: b.content ?? '',
        status: 'running', steps: [],
      } satisfies SubAgentMessage;
    }

    // Streaming assistant text (in-flight)
    if (b.kind === 'streaming') {
      return {
        id, kind: 'streaming', createdAt,
        text: b.content ?? '', startedAt: createdAt,
      } satisfies StreamingMessage;
    }

    // HTML reply
    if (b.kind === 'html') {
      return { id, kind: 'html', createdAt, html: b.content ?? '' } satisfies HtmlMessage;
    }

    // Speak messages are audio-only — skip in transcript.
    if (b.kind === 'speak') return null;

    // Error
    if (b.role === 'error' || b.kind === 'error') {
      return { id, kind: 'error', createdAt, text: b.content ?? 'An error occurred' } satisfies ErrorMessage;
    }

    // Fallback — plain assistant text
    return {
      id, kind: 'sulla', createdAt,
      text: b.content ?? '',
      model: this.controller.model.value.name,
    } satisfies SullaMessage;
  }
}

// ─── helpers ─────────────────────────────────────────────────────────
function splitThoughts(content: string): string[] {
  return content
    .split(/\n+/)
    .map(l => l.trim())
    .filter(Boolean);
}

function firstLineOf(s: string): string {
  const l = s.split(/\n/)[0]?.trim() ?? '';
  return l.length > 90 ? l.slice(0, 87) + '…' : l;
}

function truncMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const half = Math.floor((max - 1) / 2);
  return s.slice(0, half) + '…' + s.slice(-half);
}

async function fileToAttachmentInput(file: File): Promise<{ mediaType: string; base64: string }> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return { mediaType: file.type || 'application/octet-stream', base64: btoa(binary) };
}

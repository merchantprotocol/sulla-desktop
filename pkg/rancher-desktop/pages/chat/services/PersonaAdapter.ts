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

import { watch, type ComputedRef, type WatchStopHandle } from 'vue';

import { ChatInterface, type ChatMessage as BackendMessage } from '../../agent/ChatInterface';
import type { ChatController } from '../controller/ChatController';
import type { Message, UserMessage, SullaMessage, StreamingMessage, ThinkingMessage,
  ToolMessage, ChannelMessage, SubAgentMessage, CitationMessage, ErrorMessage, HtmlMessage, InterimMessage,
} from '../models/Message';
import type { Attachment } from '../models/Attachment';
import type {
  ArtifactStatus, WorkflowPayload, WorkflowNode, WorkflowEdge, HtmlPayload,
} from '../models/Artifact';
import { asMessageId, newAttachmentId, newMessageId, type ArtifactId } from '../types/chat';

export interface PersonaAdapterOptions {
  channelId?: string;
  tabId?:     string;
}

export class PersonaAdapter {
  private ci: ChatInterface;
  private stopWatchers: WatchStopHandle[] = [];

  /**
   * Mirrors ChatInterface.hasMessages — true once the user has sent their
   * first message in this tab (flag persisted in localStorage) OR there
   * are non-interim backend messages. ChatPage uses this to decide
   * whether to render EmptyState vs. Transcript, matching the old
   * BrowserTabChat semantics so restored thinking/tool crumbs from
   * localStorage don't suppress the landing on a fresh-looking tab.
   */
  readonly hasSentMessage: ComputedRef<boolean>;
  /** Backend ids we've seen (so we don't re-append duplicates on watcher fires). */
  private seen = new Set<string>();
  /** Stable createdAt timestamps keyed by backend message id. */
  private firstSeenAt = new Map<string, number>();
  /** Wall-clock ms when a thinking bubble's `completed` flipped true. Stamped
   *  once per backend id so re-mapping a long-finished thinking bubble
   *  doesn't drift the frozen elapsed label. */
  private firstCompletedAt = new Map<string, number>();
  /** Hash of the last-mapped transcript Message per backend id, for skipping no-op updates. */
  private lastMappedHash = new Map<string, string>();
  /** workflowRunId → artifactId, so repeated node events find the same artifact. */
  private workflowArtifacts = new Map<string, ArtifactId>();
  /** workflowRunId → name used when the artifact was first opened (stable across updates). */
  private workflowNames = new Map<string, string>();
  /** Backend id → artifactId for html messages we've surfaced as artifacts. */
  private htmlArtifacts = new Map<string, ArtifactId>();

  constructor(
    private readonly controller: ChatController,
    opts: PersonaAdapterOptions = {},
  ) {
    this.ci = new ChatInterface(opts.channelId ?? 'sulla-desktop', opts.tabId);
    this.hasSentMessage = this.ci.hasMessages;

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

    // Drive the run-state machine from the backend. Also re-map every
    // message whenever `graphRunning` flips — the streaming/thinking
    // mappings use it as a completion fallback, so a transition to
    // idle must re-evaluate dangling bubbles even when the underlying
    // message objects haven't changed.
    this.stopWatchers.push(
      watch(() => this.ci.graphRunning.value, (running) => {
        this.syncRunState(running);
        this.syncMessages();
      }),
    );

    // showContinueButton goes high on max_loops — mirror into paused(limit).
    this.stopWatchers.push(
      watch(() => this.ci.showContinueButton.value, (show) => {
        if (show) this.controller.transitionRun({ type: 'hitLimit' });
      }),
    );

    // Connection state — the backend's "model is initializing/loading" flag
    // degrades the connection indicator; idle/ready means online.
    // graphRunning (Sulla thinking) does NOT affect connection state.
    this.stopWatchers.push(
      watch(() => this.ci.loading.value, (loading) => {
        this.controller.setConnection(loading ? 'degraded' : 'online');
      }, { immediate: true }),
    );

    // Speak bridge — the low-latency speak listener on the persona is the
    // canonical path for TTS. We forward every speak payload to a window
    // event that VoiceSessionAdapter listens for and plays. This keeps
    // the two adapters decoupled (persona doesn't know about TTS, voice
    // doesn't know about persona).
    const unsubscribeSpeak = this.ci.onSpeakDispatch((text, _threadId, _seq) => {
      if (!text?.trim()) return;
      window.dispatchEvent(new CustomEvent('chat:speak', { detail: text }));
    });
    this.stopWatchers.push(unsubscribeSpeak);

    // Token + cost mirror — persona.state is reactive so the computeds on
    // ChatInterface re-evaluate on every update. We watch the tuple and
    // push it into ChatController.usage so the token modal + any other
    // consumer reads a single source of truth.
    this.stopWatchers.push(
      watch(
        () => [
          this.ci.totalTokensUsed.value,
          this.ci.totalPromptTokens.value,
          this.ci.totalCompletionTokens.value,
          this.ci.totalInputCost.value,
          this.ci.totalOutputCost.value,
          this.ci.totalCost.value,
          this.ci.responseCount.value,
          this.ci.averageResponseTime.value,
          this.ci.tokensPerSecond.value,
        ] as const,
        ([total, prompt, completion, inputCost, outputCost, totalCost, count, avgMs, tps]) => {
          this.controller.setUsage({
            totalTokens:      total,
            promptTokens:     prompt,
            completionTokens: completion,
            inputCost,
            outputCost,
            totalCost,
            responseCount:    count,
            avgResponseMs:    avgMs,
            tokensPerSecond:  tps,
          });
        },
        { immediate: true },
      ),
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
  newChat(): void {
    this.ci.newChat();
    this.seen.clear();
    this.firstSeenAt.clear();
    this.firstCompletedAt.clear();
    this.lastMappedHash.clear();
    this.workflowArtifacts.clear();
    this.workflowNames.clear();
    this.htmlArtifacts.clear();
  }

  dispose(): void {
    for (const stop of this.stopWatchers) stop();
    this.stopWatchers = [];
    this.firstSeenAt.clear();
    this.firstCompletedAt.clear();
    this.lastMappedHash.clear();
    this.workflowArtifacts.clear();
    this.workflowNames.clear();
    this.htmlArtifacts.clear();
    this.ci.dispose();
  }

  // ─── Sync backend → controller ─────────────────────────────────────
  private syncMessages(): void {
    const backend = this.ci.messages.value;
    for (const b of backend) {
      if (!b?.id) continue;
      const mapped = this.mapBackendMessage(b);
      // A null mapping means the message is represented elsewhere (e.g. in the
      // artifact sidebar) and should not produce a transcript entry.
      if (!mapped) {
        // Track as seen anyway so we don't repeatedly re-process it.
        this.seen.add(b.id);
        continue;
      }
      if (this.seen.has(b.id)) {
        // Existing — update mutable fields, but skip if nothing changed.
        const hash = stableHash(mapped);
        if (this.lastMappedHash.get(b.id) === hash) continue;
        this.lastMappedHash.set(b.id, hash);
        this.controller.updateMessage(mapped.id, mapped as Partial<Message>);
      } else {
        this.seen.add(b.id);
        this.lastMappedHash.set(b.id, stableHash(mapped));
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
    const createdAt = this.stableCreatedAt(b.id);

    // Workflow node events drive a workflow artifact in the sidebar — they
    // should NOT appear as transcript messages.
    if (b.kind === 'workflow_node' && b.workflowNode) {
      // Only re-apply when the node payload actually changed, to avoid a
      // reactivity storm on unrelated message-list mutations.
      const hash = stableHash(b.workflowNode);
      if (this.lastMappedHash.get(b.id) !== hash) {
        this.lastMappedHash.set(b.id, hash);
        this.applyWorkflowNode(b.workflowNode);
      }
      return null;
    }

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

    // Thinking. A thinking bubble is complete when either the per-message
    // `_completed` flag is set (the backend saw a `thinking_complete`
    // sentinel or the bubble was collapsed when a streaming segment
    // started) OR the overall graph is no longer running. Once complete,
    // stamp `completedAt` the first time we notice so the elapsed label
    // freezes at the real wall-clock duration instead of drifting.
    if (b.kind === 'thinking') {
      const thoughts = splitThoughts(b.content ?? '');
      const completed = (b as any)._completed === true || !this.ci.graphRunning.value;
      let completedAt: number | undefined;
      if (completed) {
        completedAt = this.firstCompletedAt.get(b.id);
        if (completedAt === undefined) {
          completedAt = Date.now();
          this.firstCompletedAt.set(b.id, completedAt);
        }
      }
      return {
        id, kind: 'thinking', createdAt,
        thoughts, startedAt: createdAt, completed, completedAt,
        summary: completed ? firstLineOf(b.content ?? '') : undefined,
      } satisfies ThinkingMessage;
    }

    // Citation card — source grid rendered by CitationRow.vue. Backend
    // populates `citations` via the CitationExtractor; we pass them
    // straight through unchanged. Sources must have title + origin (any
    // that don't were already dropped in MessageDispatcher).
    if (b.kind === 'citation' && Array.isArray(b.citations) && b.citations.length > 0) {
      return {
        id, kind: 'citation', createdAt,
        sources: b.citations.map(s => ({
          num:    s.num,
          title:  s.title,
          origin: s.origin,
          url:    s.url,
        })),
      } satisfies CitationMessage;
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

    // Channel message (from Heartbeat/Workbench/Mobile).
    //
    // Mobile-relay messages are intentionally NOT surfaced in the active
    // transcript — the mobile chat has its own continuity and popping
    // into the desktop conversation mid-thread is distracting. Instead,
    // we persist the mobile conversation as its own thread so it shows
    // up in the history rail and the user can pick it up there.
    //
    // Heartbeat and Workbench still render inline (they're ambient
    // background agents that don't have their own chat surface).
    if (b.kind === 'channel_message') {
      const channel = b.channelMeta?.senderChannel ?? '';
      if (isMobileRelayChannel(channel)) {
        // History-only — skip transcript render.
        return null;
      }
      return {
        id, kind: 'channel', createdAt,
        agent:   b.channelMeta?.senderId       || 'Agent',
        channel,
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

    // Streaming assistant text. Backend sets `_completed` (via `as any`)
    // when a `streaming_complete` sentinel arrives — the bubble should
    // stop showing the blinking cursor and read as a finalized reply.
    // Fall back to the global graphRunning flag so a dangling stream
    // still collapses if the backend forgot to emit the sentinel and
    // the graph has since gone idle.
    if (b.kind === 'streaming') {
      const completed = (b as any)._completed === true || !this.ci.graphRunning.value;
      if (completed) {
        // Mirror MessageDispatcher's auto-detect: if the finalized reply
        // is pure <html>...</html>, surface it as an artifact and suppress
        // the inline markdown render. Without this the completed stream
        // hits TurnSulla (marked + DOMPurify) and paints the full page
        // into the transcript at the same time the html artifact appears
        // in the sidebar — the user sees the same content twice.
        const raw = b.content ?? '';
        const htmlMatch = /^\s*<html\b[^>]*>([\s\S]*)<\/html>\s*$/i.exec(raw);

        if (htmlMatch) {
          const html = htmlMatch[1].trim();
          const artifactId = this.ensureHtmlArtifact(b.id, html, createdAt);

          return { id, kind: 'html', createdAt, html, artifactId } satisfies HtmlMessage;
        }
        return {
          id, kind: 'sulla', createdAt,
          text:  raw,
          model: this.controller.model.value.name,
        } satisfies SullaMessage;
      }
      return {
        id, kind: 'streaming', createdAt,
        text: b.content ?? '', startedAt: createdAt,
      } satisfies StreamingMessage;
    }

    // HTML reply — also surface as an artifact so the user can expand it.
    if (b.kind === 'html') {
      const html = b.content ?? '';
      const artifactId = this.ensureHtmlArtifact(b.id, html, createdAt);
      return { id, kind: 'html', createdAt, html, artifactId } satisfies HtmlMessage;
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

  // ─── Stable timestamps ────────────────────────────────────────────
  private stableCreatedAt(backendId: string): number {
    const existing = this.firstSeenAt.get(backendId);
    if (existing !== undefined) return existing;
    const now = Date.now();
    this.firstSeenAt.set(backendId, now);
    return now;
  }

  // ─── Workflow artifact driver ─────────────────────────────────────
  private applyWorkflowNode(node: NonNullable<BackendMessage['workflowNode']>): void {
    const runId = node.workflowRunId;

    // Find-or-reopen the artifact for this run. `openArtifact` on the
    // controller reuses an existing artifact with matching kind + name,
    // or creates a new one if the previous was closed. We include a
    // short slice of `runId` so two concurrent runs whose first node
    // shares a label don't collide into the same artifact.
    let name = this.workflowNames.get(runId);
    if (!name) {
      const label = node.nodeLabel || 'run';
      const tag = runId ? ` · ${ String(runId).slice(0, 6) }` : '';
      name = `Workflow • ${ label }${ tag }`;
      this.workflowNames.set(runId, name);
    }

    const artifactId = this.controller.openArtifact('workflow', {
      name,
      payload: this.initialWorkflowPayload(runId),
      status:  'working',
    });
    this.workflowArtifacts.set(runId, artifactId);

    // Merge this node event into the existing payload.
    const current = this.controller.artifacts.value.list.find(a => a.id === artifactId);
    const prev = (current?.payload as WorkflowPayload | undefined) ?? this.initialWorkflowPayload(runId);
    const nextPayload = this.mergeWorkflowNode(prev, node);
    const nextStatus = this.deriveWorkflowStatus(nextPayload.nodes);

    this.controller.updateArtifact(artifactId, {
      payload: nextPayload,
      status:  nextStatus,
    });
  }

  private initialWorkflowPayload(runId: string): WorkflowPayload {
    return { nodes: [], edges: [], workflowRunId: runId };
  }

  private mergeWorkflowNode(
    prev: WorkflowPayload,
    node: NonNullable<BackendMessage['workflowNode']>,
  ): WorkflowPayload {
    const state = mapWorkflowNodeState(node.status);
    const x = 20 + node.nodeIndex * 220;
    const y = 60 + (node.nodeIndex % 2) * 110;

    const incoming: WorkflowNode = {
      id:        node.nodeId,
      x,
      y,
      kicker:    `#${ node.nodeIndex + 1 }`,
      name:      node.nodeLabel || `Node ${ node.nodeIndex + 1 }`,
      state,
      nodeIndex: node.nodeIndex,
    };

    // Replace-or-append the node by id.
    const existingIdx = prev.nodes.findIndex(n => n.id === incoming.id);
    const nodes = existingIdx >= 0
      ? prev.nodes.map((n, i) => (i === existingIdx ? { ...n, ...incoming } : n))
      : [...prev.nodes, incoming];

    // Add an edge from the previous (by nodeIndex) node to this one.
    let edges = prev.edges;
    if (node.nodeIndex > 0) {
      const from = nodes.find(n => (n.nodeIndex ?? -1) === node.nodeIndex - 1);
      if (from && from.id !== incoming.id) {
        const alreadyHasEdge = edges.some(e => e.from === from.id && e.to === incoming.id);
        if (!alreadyHasEdge) {
          const edge: WorkflowEdge = {
            from:  from.id,
            to:    incoming.id,
            state: state === 'done' ? 'done' : (state === 'active' ? 'active' : 'idle'),
          };
          edges = [...edges, edge];
        } else {
          // Refresh edge state to reflect node progression.
          edges = edges.map(e =>
            (e.from === from.id && e.to === incoming.id)
              ? { ...e, state: state === 'done' ? 'done' : (state === 'active' ? 'active' : e.state) }
              : e,
          );
        }
      }
    }

    const activeNodeId = state === 'active' ? incoming.id : prev.activeNodeId;

    return {
      ...prev,
      nodes,
      edges,
      activeNodeId,
    };
  }

  private deriveWorkflowStatus(nodes: WorkflowNode[]): ArtifactStatus {
    if (nodes.length === 0) return 'working';
    if (nodes.some(n => n.state === 'error')) return 'error';
    if (nodes.every(n => n.state === 'done')) return 'done';
    return 'working';
  }

  // ─── HTML artifact driver ─────────────────────────────────────────
  private ensureHtmlArtifact(backendId: string, html: string, createdAt: number): ArtifactId {
    const existing = this.htmlArtifacts.get(backendId);
    const name = `HTML Reply — ${ shortStamp(createdAt) }`;
    const payload: HtmlPayload = { html };
    if (existing) {
      this.controller.updateArtifact(existing, { payload, status: 'done' });
      return existing;
    }
    const artifactId = this.controller.openArtifact('html', {
      name,
      payload,
      status: 'done',
    });
    this.htmlArtifacts.set(backendId, artifactId);
    return artifactId;
  }
}

// ─── helpers ─────────────────────────────────────────────────────────
/**
 * Mobile-relay channels feed paired-phone conversations into the desktop.
 * We want those to be pickup-able from history but not pop into the
 * active chat — so the adapter drops them from transcript rendering
 * when this predicate is true.
 */
function isMobileRelayChannel(channel: string): boolean {
  const c = (channel || '').toLowerCase();
  return c === 'mobile-relay' || c === 'mobile' || c.startsWith('mobile-');
}

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

function mapWorkflowNodeState(
  status: 'running' | 'completed' | 'failed' | 'waiting',
): WorkflowNode['state'] {
  switch (status) {
    case 'running':   return 'active';
    case 'completed': return 'done';
    case 'failed':    return 'error';
    case 'waiting':   return 'idle';
    default:          return 'idle';
  }
}

function shortStamp(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${ hh }:${ mm }:${ ss }`;
}

/** Deterministic JSON.stringify — safe for plain Message objects. */
function stableHash(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    // Circular or non-serializable — fall back to a random-ish string so we
    // always trigger an update rather than silently dropping one.
    return String(Math.random());
  }
}

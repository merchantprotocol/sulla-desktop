/*
  ChatController — the SINGLE SOURCE OF TRUTH for one chat thread.

  Rules:
    • The controller is the only thing that mutates state.
    • Components read reactive refs/computed and dispatch commands.
    • All run-state transitions go through runStateMachine.ts.
    • Services (voice, attachments, transport) are private. Components
      never import services directly; they talk to the controller.
    • `serialize()` produces a ThreadState that can rehydrate the entire
      controller — used for multi-tab, history, and resumption.

  Instantiate one per thread. The ThreadRegistry tracks all live
  controllers so multiple threads can live in the same window.
*/

import { reactive, ref, computed, type Ref, type ComputedRef } from 'vue';

import type {
  Artifact, ArtifactKind, WorkflowPayload, HtmlPayload, CodePayload,
  Attachment,
  Message, UserMessage, SullaMessage, StreamingMessage, ThinkingMessage, ToolMessage,
  ToolApprovalMessage, PatchMessage, ChannelMessage, SubAgentMessage,
  CitationMessage, MemoryMessage, ProactiveMessage, HtmlMessage, ErrorMessage,
  ModalState, ModelDescriptor, SidebarState, ConnectionState,
  PopoverState, SlashCommand, MentionTarget,
  QueuedMessage,
  RunState,
  Thread, ThreadState,
  VoiceState,
} from '../models';

import { idle as runIdle, isRunning }   from '../models/RunState';
import { popoverClosed, defaultSlashCommands } from '../models/Command';
import { voiceIdle }                    from '../models/VoiceState';

import {
  type MessageId, type ArtifactId, type AttachmentId, type QueuedId, type ThreadId,
  newMessageId, newArtifactId, newThreadId, newQueuedId, newTurnId,
} from '../types/chat';

import { nextRunState, type RunEvent } from './runStateMachine';
import { EventBus, type ChatEvent, type Unsubscribe } from './events';

// ─── Defaults ─────────────────────────────────────────────────────
const DEFAULT_MODEL: ModelDescriptor = {
  id: 'claude-opus-4-7', name: 'opus-4.7', tier: 'hosted', ctx: '1M ctx',
};

// ─── Controller options ───────────────────────────────────────────
export interface ChatControllerOptions {
  /** Initial snapshot — if provided, the controller hydrates from it. */
  hydrateFrom?: ThreadState;
  /** Controls how new messages are persisted. Omit to skip persistence. */
  persister?: ThreadPersister;
  /** WS channel this thread lives on (e.g. 'sulla-desktop'). */
  channelId?: string;
  /** Per-tab scoping key; used in persister. */
  tabId?: string;
  /**
   * When set, `send()` fully delegates to this handler instead of
   * performing the default optimistic local append + runState transition.
   * Use this to wire the controller into a real backend (e.g. the
   * persona adapter); the backend is expected to emit messages back
   * into the controller via appendMessage / updateMessage.
   */
  sendHandler?: SendHandler;
}

export type SendHandler = (
  text: string,
  attachments: Attachment[],
) => void | Promise<void>;

export interface ThreadPersister {
  save(state: ThreadState): void | Promise<void>;
  load(id: ThreadId): ThreadState | null | Promise<ThreadState | null>;
  list(): ThreadState[] | Promise<ThreadState[]>;
  remove(id: ThreadId): void | Promise<void>;
}

// ─── Controller ───────────────────────────────────────────────────
export class ChatController {
  // ─── Reactive state — THE SINGLE SOURCE OF TRUTH ───────────────
  readonly thread:          Ref<Thread>;
  readonly runState:        Ref<RunState>;
  readonly queue:           Ref<QueuedMessage[]>;
  readonly staged:          Ref<Attachment[]>;
  readonly voice:           Ref<VoiceState>;
  readonly artifacts:       Ref<{ list: Artifact[]; activeId: ArtifactId | null }>;
  readonly popover:         Ref<PopoverState>;
  readonly modals:          Ref<ModalState>;
  readonly sidebar:         Ref<SidebarState>;
  readonly connection:      Ref<ConnectionState>;
  readonly model:           Ref<ModelDescriptor>;

  // Derived views — read-only computed helpers components can consume.
  readonly messages:          ComputedRef<Message[]>;
  readonly isRunning:         ComputedRef<boolean>;
  readonly hasQueue:          ComputedRef<boolean>;
  readonly activeArtifact:    ComputedRef<Artifact | null>;
  readonly canSend:           ComputedRef<boolean>;

  // Events
  private readonly bus = new EventBus<ChatEvent>();
  on = this.bus.on.bind(this.bus);

  private readonly persister?: ThreadPersister;
  private readonly channelId:  string;
  private readonly tabId?:     string;
  private sendHandler?:     SendHandler;
  private stopHandler?:     () => void;
  private continueHandler?: () => void;

  // Internal timers (voice interim, thinking tick, etc.) — kept as refs
  // on the instance so dispose() can clear them.
  private timers = new Set<ReturnType<typeof setInterval>>();

  constructor(opts: ChatControllerOptions = {}) {
    this.persister   = opts.persister;
    this.channelId   = opts.channelId ?? 'sulla-desktop';
    this.tabId       = opts.tabId;
    this.sendHandler = opts.sendHandler;

    const initial: ThreadState = opts.hydrateFrom ?? this.fresh();

    this.thread    = ref(initial.thread);
    this.runState  = ref(initial.runState);
    this.queue     = ref([...initial.queue]);
    this.staged    = ref([...initial.staged]);
    this.voice     = ref(initial.voice);
    this.artifacts = ref({ list: [...initial.artifacts], activeId: initial.activeArtifactId });
    this.popover   = ref(initial.popover);
    this.modals    = ref(initial.modals);
    this.sidebar   = ref(initial.sidebar);
    this.connection = ref(initial.connection);
    this.model     = ref(initial.model);

    this.messages       = computed(() => this.thread.value.messages);
    this.isRunning      = computed(() => isRunning(this.runState.value));
    this.hasQueue       = computed(() => this.queue.value.length > 0);
    this.activeArtifact = computed(() => {
      const id = this.artifacts.value.activeId;
      return id ? (this.artifacts.value.list.find(a => a.id === id) ?? null) : null;
    });
    this.canSend = computed(() => true);  // Always allowed; queued when running.

    if (opts.hydrateFrom) this.bus.emit({ kind: 'threadHydrated', threadId: this.thread.value.id });
  }

  // ─── Lifecycle ──────────────────────────────────────────────────
  dispose(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers.clear();
    this.bus.clear();
  }

  // ─── Send / queue ────────────────────────────────────────────────
  send(text: string, attachments: Attachment[] = []): void {
    if (isRunning(this.runState.value)) { this.queueMessage(text, attachments); return; }
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return;

    // Delegation mode — the backend owns message creation & runState.
    // Clear local staging so the composer resets; everything else flows
    // back in through the adapter's sync.
    if (this.sendHandler) {
      this.staged.value = [];
      this.autoTitleFromFirstUserMessage(trimmed);
      void this.sendHandler(trimmed || '(attached)', attachments);
      return;
    }

    const userMsg: UserMessage = {
      id: newMessageId(),
      kind: 'user',
      createdAt: Date.now(),
      turnId: newTurnId(),
      text: trimmed,
      attachments: attachments.map(a => ({ id: a.id, name: a.name, size: a.size, kind: a.kind })),
    };
    this.appendMessage(userMsg);
    this.staged.value = [];  // clear staging after send
    this.autoTitleFromFirstUserMessage(trimmed);

    // Kick off a thinking phase; Transport will drive the rest.
    this.transitionRun({ type: 'send', messageId: userMsg.id });
    this.persist();
  }

  /** Swap the send handler after construction — used when the adapter
   *  attaches post-controller-create. */
  setSendHandler(h: SendHandler | undefined): void {
    this.sendHandler = h;
  }

  queueMessage(text: string, attachments: Attachment[] = []): void {
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return;
    const q: QueuedMessage = {
      id: newQueuedId(),
      text: trimmed,
      attachments: [...attachments],
      queuedAt: Date.now(),
    };
    this.queue.value = [...this.queue.value, q];
    this.persist();
  }

  injectQueuedMessage(id: QueuedId): void {
    const q = this.queue.value.find(m => m.id === id);
    if (!q) return;
    this.queue.value = this.queue.value.filter(m => m.id !== id);
    this.send(q.text, [...q.attachments]);
  }

  removeQueuedMessage(id: QueuedId): void {
    this.queue.value = this.queue.value.filter(m => m.id !== id);
    this.persist();
  }

  moveQueuedMessage(id: QueuedId, direction: 'up' | 'down'): void {
    const arr = [...this.queue.value];
    const i = arr.findIndex(m => m.id === id);
    if (i < 0) return;
    const j = direction === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    this.queue.value = arr;
    this.persist();
  }

  clearQueue(): void {
    this.queue.value = [];
    this.persist();
  }

  /** Drains the first queued message if no run is active. */
  drainQueueIfIdle(): void {
    if (isRunning(this.runState.value)) return;
    const [first, ...rest] = this.queue.value;
    if (!first) return;
    this.queue.value = rest;
    this.send(first.text, [...first.attachments]);
  }

  // ─── Run control ────────────────────────────────────────────────
  stop(): void {
    this.stopHandler?.();
    this.transitionRun({ type: 'stop' });
  }

  continueRun(): void {
    this.continueHandler?.();
    this.transitionRun({ type: 'continue' });
  }

  /** Adapter hook — set after construction so backend stop/continue flow through. */
  setRunHandlers(handlers: { onStop?: () => void; onContinue?: () => void }): void {
    this.stopHandler     = handlers.onStop;
    this.continueHandler = handlers.onContinue;
  }

  // ─── Message CRUD ───────────────────────────────────────────────
  appendMessage(m: Message): void {
    this.thread.value = {
      ...this.thread.value,
      messages:  [...this.thread.value.messages, m],
      updatedAt: Date.now(),
    };
    this.bus.emit({ kind: 'messageAppended', threadId: this.thread.value.id, message: m });
  }

  updateMessage<T extends Message>(id: MessageId, patch: Partial<T>): void {
    const idx = this.thread.value.messages.findIndex(m => m.id === id);
    if (idx < 0) return;
    const next = [...this.thread.value.messages];
    next[idx] = { ...next[idx], ...patch } as Message;
    this.thread.value = { ...this.thread.value, messages: next, updatedAt: Date.now() };
    this.bus.emit({ kind: 'messageUpdated', threadId: this.thread.value.id, messageId: id, patch });
  }

  removeMessage(id: MessageId): void {
    this.thread.value = {
      ...this.thread.value,
      messages:  this.thread.value.messages.filter(m => m.id !== id),
      updatedAt: Date.now(),
    };
    this.bus.emit({ kind: 'messageRemoved', threadId: this.thread.value.id, messageId: id });
  }

  editMessage(id: MessageId, text: string): void {
    const msg = this.thread.value.messages.find(m => m.id === id);
    if (!msg || msg.kind !== 'user') return;
    this.updateMessage<UserMessage>(id, { text });
    // (Re-running from this point is the caller's responsibility.)
  }

  regenerate(fromId: MessageId): void {
    // Find the last user message at-or-before fromId and re-send from there.
    const msgs = this.thread.value.messages;
    const idx  = msgs.findIndex(m => m.id === fromId);
    if (idx < 0) return;
    let userIdx = idx;
    while (userIdx >= 0 && msgs[userIdx].kind !== 'user') userIdx--;
    if (userIdx < 0) return;
    const user = msgs[userIdx] as UserMessage;
    this.thread.value = {
      ...this.thread.value,
      messages: msgs.slice(0, userIdx + 1),
      updatedAt: Date.now(),
    };
    this.transitionRun({ type: 'send', messageId: user.id });
    this.persist();
  }

  togglePin(id: MessageId): void {
    const msg = this.thread.value.messages.find(m => m.id === id);
    if (!msg) return;
    this.updateMessage(id, { pinned: !msg.pinned });
  }

  // ─── Patch actions ──────────────────────────────────────────────
  applyPatch(id: MessageId): void {
    const msg = this.thread.value.messages.find(m => m.id === id);
    if (!msg || msg.kind !== 'patch') return;
    this.updateMessage<PatchMessage>(id, { state: 'applied' });
    this.bus.emit({ kind: 'patchApplied', threadId: this.thread.value.id, messageId: id });
  }
  rejectPatch(id: MessageId): void {
    const msg = this.thread.value.messages.find(m => m.id === id);
    if (!msg || msg.kind !== 'patch') return;
    this.updateMessage<PatchMessage>(id, { state: 'rejected' });
  }

  // ─── Tool approval ──────────────────────────────────────────────
  approveTool(id: MessageId): void {
    this.updateMessage<ToolApprovalMessage>(id, { decision: 'approved' });
    this.transitionRun({ type: 'approvalResolved' });
  }
  denyTool(id: MessageId): void {
    this.updateMessage<ToolApprovalMessage>(id, { decision: 'denied' });
    this.transitionRun({ type: 'approvalResolved' });
  }

  // ─── Attachments ────────────────────────────────────────────────
  stageAttachment(a: Attachment): void {
    this.staged.value = [...this.staged.value, a];
  }
  unstageAttachment(id: AttachmentId): void {
    this.staged.value = this.staged.value.filter(a => a.id !== id);
  }
  clearStagedAttachments(): void {
    this.staged.value = [];
  }

  // ─── Voice ──────────────────────────────────────────────────────
  setVoice(v: VoiceState): void {
    this.voice.value = v;
    if (v.phase === 'recording')   this.bus.emit({ kind: 'voiceStarted', threadId: this.thread.value.id });
    if (v.phase === 'playing')     this.bus.emit({ kind: 'ttsStarted', threadId: this.thread.value.id, messageId: v.refId });
  }
  stopVoice(commit: boolean = true): void {
    this.voice.value = voiceIdle();
    this.bus.emit({ kind: 'voiceStopped', threadId: this.thread.value.id, committed: commit });
  }
  stopTTS(messageId?: MessageId): void {
    const v = this.voice.value;
    if (v.phase === 'playing') {
      this.voice.value = voiceIdle();
      this.bus.emit({ kind: 'ttsStopped', threadId: this.thread.value.id, messageId: messageId ?? v.refId });
    }
  }

  // ─── Artifacts ──────────────────────────────────────────────────
  openArtifact(kind: ArtifactKind, partial: Partial<Artifact> = {}): ArtifactId {
    // Reuse an existing artifact of the same kind + name if one exists.
    const existing = this.artifacts.value.list.find(
      a => a.kind === kind && (!partial.name || a.name === partial.name),
    );
    if (existing) {
      this.artifacts.value = { list: this.artifacts.value.list, activeId: existing.id };
      return existing.id;
    }
    const artifact: Artifact = {
      id:        newArtifactId(),
      kind,
      name:      partial.name ?? defaultArtifactName(kind),
      status:    partial.status ?? 'working',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      payload:   partial.payload,
    };
    this.artifacts.value = {
      list:     [...this.artifacts.value.list, artifact],
      activeId: artifact.id,
    };
    this.bus.emit({ kind: 'artifactOpened', threadId: this.thread.value.id, artifactId: artifact.id });
    return artifact.id;
  }
  switchArtifact(id: ArtifactId): void {
    if (!this.artifacts.value.list.some(a => a.id === id)) return;
    this.artifacts.value = { ...this.artifacts.value, activeId: id };
  }
  closeArtifact(id: ArtifactId): void {
    const list = this.artifacts.value.list.filter(a => a.id !== id);
    const activeId = this.artifacts.value.activeId === id
      ? (list[0]?.id ?? null)
      : this.artifacts.value.activeId;
    this.artifacts.value = { list, activeId };
    this.bus.emit({ kind: 'artifactClosed', threadId: this.thread.value.id, artifactId: id });
  }
  updateArtifact(id: ArtifactId, patch: Partial<Artifact>): void {
    const list = this.artifacts.value.list.map(a =>
      a.id === id ? { ...a, ...patch, updatedAt: Date.now() } : a,
    );
    this.artifacts.value = { ...this.artifacts.value, list };
  }

  // ─── Modals & sidebar ───────────────────────────────────────────
  openModal(which: ModalState['which']): void {
    this.modals.value = { which };
  }
  closeModal(): void {
    this.modals.value = { which: null };
  }
  toggleHistory(): void {
    this.sidebar.value = { ...this.sidebar.value, historyOpen: !this.sidebar.value.historyOpen };
  }

  // ─── Model ──────────────────────────────────────────────────────
  switchModel(model: ModelDescriptor): void {
    this.model.value = model;
    this.bus.emit({ kind: 'modelSwitched', threadId: this.thread.value.id, modelId: model.id });
  }

  // ─── Title ──────────────────────────────────────────────────────
  renameThread(title: string): void {
    this.thread.value = { ...this.thread.value, title, updatedAt: Date.now() };
    this.bus.emit({ kind: 'titleChanged', threadId: this.thread.value.id, title });
    this.persist();
  }

  // ─── Popover (slash / mention) ──────────────────────────────────
  showPopover(mode: 'slash' | 'mention', query: string, items: readonly (SlashCommand | MentionTarget)[]): void {
    this.popover.value = { open: true, mode, items, selected: 0, query };
  }
  movePopoverSelection(delta: 1 | -1): void {
    const p = this.popover.value;
    if (!p.open) return;
    const next = Math.max(0, Math.min(p.items.length - 1, p.selected + delta));
    this.popover.value = { ...p, selected: next };
  }
  hidePopover(): void {
    this.popover.value = popoverClosed();
  }

  // ─── Connection ─────────────────────────────────────────────────
  setConnection(state: ConnectionState): void {
    if (this.connection.value === state) return;
    this.connection.value = state;
    this.bus.emit({ kind: 'connectionChanged', threadId: this.thread.value.id, state });
  }

  // ─── Run-state transitions (the ONLY way runState changes) ──────
  transitionRun(ev: RunEvent): void {
    const from = this.runState.value;
    const to   = nextRunState(from, ev);
    if (to === from) return;
    this.runState.value = to;
    this.bus.emit({ kind: 'runStateChanged', threadId: this.thread.value.id, from, to });
    if (!isRunning(to) && this.queue.value.length > 0 && to.phase === 'idle') {
      // Drain the queue when idle.
      queueMicrotask(() => this.drainQueueIfIdle());
    }
  }

  // ─── Serialization / hydration ──────────────────────────────────
  serialize(): ThreadState {
    const state: ThreadState = {
      thread:           this.thread.value,
      runState:         this.runState.value,
      queue:            [...this.queue.value],
      staged:           [...this.staged.value],
      voice:            this.voice.value,
      artifacts:        [...this.artifacts.value.list],
      activeArtifactId: this.artifacts.value.activeId,
      popover:          popoverClosed(),   // popovers don't persist
      modals:           { which: null },   // modals don't persist
      sidebar:          this.sidebar.value,
      connection:       this.connection.value,
      model:            this.model.value,
    };
    this.bus.emit({ kind: 'threadSerialized', threadId: this.thread.value.id });
    return state;
  }

  hydrate(state: ThreadState): void {
    this.thread.value = state.thread;
    this.runState.value = state.runState;
    this.queue.value = [...state.queue];
    this.staged.value = [...state.staged];
    this.voice.value = state.voice;
    this.artifacts.value = { list: [...state.artifacts], activeId: state.activeArtifactId };
    this.popover.value = popoverClosed();
    this.modals.value = { which: null };
    this.sidebar.value = state.sidebar;
    this.connection.value = state.connection;
    this.model.value = state.model;
    this.bus.emit({ kind: 'threadHydrated', threadId: state.thread.id });
  }

  // ─── Helpers ────────────────────────────────────────────────────
  private persist(): void {
    if (!this.persister) return;
    try { this.persister.save(this.serialize()); }
    catch (e) { console.error('[ChatController] persist failed:', e); }
  }

  private autoTitleFromFirstUserMessage(text: string): void {
    if (this.thread.value.title && this.thread.value.title !== 'New chat') return;
    const first = text.replace(/\s+/g, ' ').trim().split(/[.!?\n]/)[0].trim();
    const MAX = 44;
    const title = first.length > MAX
      ? first.slice(0, first.lastIndexOf(' ', MAX) || MAX) + '…'
      : first || 'New chat';
    this.thread.value = { ...this.thread.value, title };
  }

  private fresh(): ThreadState {
    const thread: Thread = {
      id:        newThreadId(),
      title:     'New chat',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages:  [],
    };
    return {
      thread,
      runState: runIdle(),
      queue: [],
      staged: [],
      voice: voiceIdle(),
      artifacts: [],
      activeArtifactId: null,
      popover: popoverClosed(),
      modals: { which: null },
      sidebar: { historyOpen: false },
      connection: 'online',
      model: DEFAULT_MODEL,
    };
  }
}

function defaultArtifactName(kind: ArtifactKind): string {
  switch (kind) {
    case 'workflow': return 'Workflow';
    case 'html':     return 'HTML Artifact';
    case 'code':     return 'Code';
  }
}

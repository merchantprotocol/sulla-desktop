// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { computed, ref, watch } from 'vue';

import type { ChatController } from '../controller/ChatController';
import type { Message } from '../models/Message';
import type { RemoteThreadBinding } from '../models/Thread';
import { asMessageId } from '../types/chat';
import { RemoteChatHistory } from './RemoteChatHistory';

type Frame = Record<string, unknown>;
type Scope = { accountId: string; workspaceId: string };
export interface RemoteChatTransport {
  connect(): Promise<Scope | null>;
  send(frame: Frame): Promise<boolean>;
  listen(receive: (frame: Frame) => void): () => void;
  history: ConstructorParameters<typeof RemoteChatHistory>[0];
}
export type RemoteModel = { providerId: string; modelId: string };
export type RemoteDevice = { id: string; name: string; models: RemoteModel[]; threads?: { id: string; updatedAt: number }[] };
type State = 'Connecting…' | 'Connected' | 'Connected · Catching up…' | 'Connected · History unavailable' | 'Offline' | 'Access unavailable';

export class RemoteChatSession {
  readonly devices = ref<RemoteDevice[]>([]);
  readonly selected = ref<RemoteDevice>();
  readonly model = ref<RemoteModel>();
  readonly status = ref<State>('Offline');
  readonly note = ref('');
  readonly available = ref(false);
  readonly running = ref(false);
  readonly bound = computed(() => this.chat.thread.value.remote);
  readonly chosen = computed(() => this.devices.value.find(device => device.id === (this.bound.value?.deviceId ?? this.selected.value?.id)));
  readonly remote = computed(() => Boolean(this.bound.value || this.selected.value));
  readonly models = computed(() => this.chosen.value?.models ?? []);
  private scope?: Scope;
  private inventory = '';
  private inventoryRows: RemoteDevice[] = [];
  private inventoryTimer?: ReturnType<typeof setTimeout>;
  private subscribed = '';
  private routeBinding?: RemoteThreadBinding;
  private subscription = '';
  private routing = false;
  private revision = 0;
  private liveRun = '';
  private sendTimer?: ReturnType<typeof setTimeout>;
  private subscribeTimer?: ReturnType<typeof setTimeout>;
  private buffer?: Map<string, Message>;
  private historyDirty = false;
  private history: RemoteChatHistory;
  private cleanup?: () => void;
  private disposed = false;

  constructor(private readonly chat: ChatController, private readonly transport: RemoteChatTransport,
    private readonly acceptedDraft: (text: string) => void, private readonly active: () => boolean) {
    this.history = new RemoteChatHistory((...args) => transport.history(...args));
  }

  mount(): void {
    this.disposed = false;
    const stopListening = this.transport.listen(frame => { void this.receive(frame) });
    const unwatch = watch(() => this.chat.thread.value.id, () => {
      this.unsubscribe();
      this.select(undefined);
      this.note.value = '';
      void this.refresh();
    });
    this.chat.remoteStop = () => this.stop();
    this.cleanup = () => {
      this.disposed = true;
      this.unsubscribe();
      clearTimeout(this.inventoryTimer);
      this.inventory = '';
      this.chat.remoteStop = undefined;
      this.chat.remoteDraftSelected = false;
      this.chat.remoteDiscoveries.value = [];
      stopListening();
      unwatch();
    };
  }

  dispose(): void { this.cleanup?.(); this.cleanup = undefined }

  select(device: RemoteDevice | undefined): void {
    this.selected.value = device;
    this.chat.remoteDraftSelected = Boolean(device);
    this.model.value = undefined;
    this.note.value = '';
  }

  private async send(frame: Frame): Promise<boolean> {
    try { return await this.transport.send(frame) } catch { return false }
  }

  private command(type: string, binding: RemoteThreadBinding, extra: Frame = {}): Frame {
    return { type, conversationId: binding.threadId, targetDeviceId: binding.deviceId, ...extra };
  }

  async refresh(catchUp = false): Promise<void> {
    try {
      const scope = await this.transport.connect();
      if (this.disposed || !scope) return;
      this.ready(scope);
      const binding = this.bound.value;
      if (catchUp && binding && this.subscribed === binding.threadId && !this.buffer && !binding.pending) {
        void this.catchUp(binding);
      }
    } catch { /* No Cloud dependency for local mode. */ }
  }

  private ready(scope: Scope): void {
    if (this.scope && (this.scope.accountId !== scope.accountId || this.scope.workspaceId !== scope.workspaceId)) this.offline();
    this.scope = scope;
    this.available.value = true;
    if (this.active() && !this.inventory) {
      this.inventory = crypto.randomUUID();
      const requestId = this.inventory;
      this.inventoryRows = [];
      void this.send({ type: 'relay_inventory', requestId });
      this.inventoryTimer = setTimeout(() => {
        if (this.inventory !== requestId) return;
        this.inventory = '';
        this.applyInventory();
      }, 8000);
    }
    const binding = this.bound.value;
    if (!binding || this.routing || this.subscribed) return;
    if (binding.accountId !== scope.accountId || binding.workspaceId !== scope.workspaceId) {
      this.status.value = 'Access unavailable';
      return;
    }
    if (binding.pending) this.checkReceipt();
    else this.subscribe(binding);
  }

  private applyInventory(): void {
    this.devices.value = this.inventoryRows;
    const scope = this.scope;
    this.chat.remoteDiscoveries.value = scope ? this.devices.value.flatMap(device =>
      (device.threads ?? []).map(thread => ({ updatedAt: thread.updatedAt,
        binding: { ...scope, threadId: thread.id, deviceId: device.id, name: device.name } }))) : [];
    const b = this.bound.value;
    if (b && this.subscribed && !this.devices.value.some(device => device.id === b.deviceId)) {
      this.unsubscribe();
      this.status.value = 'Offline';
    }
  }

  private checkReceipt(): void {
    const binding = this.bound.value;
    if (!binding?.pending || !this.scope || this.routing || this.disposed) return;
    this.routing = true;
    this.note.value = 'Checking whether the device accepted your message…';
    const id = binding.pending.id;
    void this.send(this.command('relay_receipt', binding, { userMessageId: id }));
    clearTimeout(this.sendTimer);
    this.sendTimer = setTimeout(() => {
      if (this.bound.value?.pending?.id !== id) return;
      this.routing = false;
      this.note.value = 'Acceptance is unknown. Your message was not resent.';
    }, 8000);
  }

  private subscribe(binding: RemoteThreadBinding): void {
    this.routing = true;
    this.status.value = 'Connecting…';
    this.routeBinding = binding;
    this.subscription = crypto.randomUUID();
    const subscriptionId = this.subscription;
    void this.send(this.command('relay_subscribe', binding, { subscriptionId }));
    clearTimeout(this.subscribeTimer);
    this.subscribeTimer = setTimeout(() => {
      if (this.subscription !== subscriptionId) return;
      this.routing = false;
      this.subscription = '';
      this.status.value = 'Offline';
    }, 8000);
  }

  private offline(): void {
    this.unsubscribe(false);
    this.devices.value = [];
    this.chat.remoteDiscoveries.value = [];
    this.inventory = '';
    clearTimeout(this.inventoryTimer);
    this.scope = undefined;
    this.status.value = 'Offline';
  }

  private unsubscribe(send = true): void {
    const binding = this.routeBinding;
    if (send && binding) void this.send(this.command('relay_unsubscribe', binding));
    this.routeBinding = undefined;
    this.subscription = this.subscribed = this.liveRun = '';
    this.routing = false;
    this.running.value = false;
    this.buffer = undefined;
    this.historyDirty = false;
    this.revision++;
    clearTimeout(this.sendTimer);
    clearTimeout(this.subscribeTimer);
  }

  canSend(): boolean {
    const status = this.status.value;
    const b = this.bound.value;
    const model = this.model.value;
    return !!this.scope && !!model && !b?.pending && !this.routing && !this.running.value && (!b || (!!this.subscribed && status.startsWith('Connected')))
      && this.models.value.some(candidate => candidate.providerId === model.providerId && candidate.modelId === model.modelId);
  }

  async sendDraft(text: string): Promise<void> {
    const device = this.chosen.value;
    if (!device) { this.note.value = 'Device unavailable. Your draft stays here.'; return }
    const model = this.model.value;
    if (!model || !this.models.value.some(entry => entry.providerId === model.providerId && entry.modelId === model.modelId)) {
      this.note.value = 'Choose a model available on this device.';
      return;
    }
    if (!text.trim() || !this.canSend() || !this.scope) return;
    this.note.value = '';
    const selectedThread = this.chat.thread.value.id;
    const previous = this.bound.value;
    const pending = { id: crypto.randomUUID(), text };
    const binding = { ...(previous ?? { ...this.scope, threadId: `remote_${ crypto.randomUUID() }`, deviceId: device.id, name: device.name }), pending };
    this.updateBinding(binding);
    this.routing = true;
    this.status.value = 'Connecting…';
    const sent = await this.send(this.command('chat', binding, { ...model, text, userMessageId: pending.id }));
    if (this.disposed || this.chat.thread.value.id !== selectedThread || this.bound.value?.pending?.id !== pending.id) return;
    if (!sent) {
      this.routing = false;
      this.updateBinding(previous);
      this.status.value = this.subscribed ? 'Connected' : 'Offline';
      this.note.value = 'Device unavailable. Your draft stays here.';
      return;
    }
    this.sendTimer = setTimeout(() => { this.routing = false; this.checkReceipt() }, 8000);
  }

  private updateBinding(remote: RemoteThreadBinding | undefined): void {
    this.chat.thread.value = { ...this.chat.thread.value, remote };
    this.chat.persistThread();
  }

  stop(): void {
    const b = this.bound.value;
    if (b && this.subscribed === b.threadId && this.liveRun) void this.send(this.command('cancel', b, { clientRunId: this.liveRun }));
  }

  private committed(message: Message): void {
    if (this.buffer) { this.buffer.set(message.id, message); return }
    const thread = this.chat.thread.value;
    if (!thread.messages.some(existing => existing.id === message.id)) this.chat.appendMessage(message);
    this.chat.persistThread();
  }

  private async catchUp(binding: RemoteThreadBinding): Promise<void> {
    this.historyDirty = false;
    const ticket = ++this.revision;
    const alive = () => !this.disposed && this.revision === ticket && this.bound.value?.threadId === binding.threadId && this.subscribed === binding.threadId;
    const live = this.buffer = new Map<string, Message>();
    this.status.value = 'Connected · Catching up…';
    const result = await this.history.catchUp(binding, this.chat.messages.value, alive).catch(() => undefined);
    if (!alive()) return;
    this.buffer = undefined;
    if (!result) {
      this.status.value = 'Connected · History unavailable';
      for (const message of live.values()) this.committed(message);
      if (this.historyDirty) void this.catchUp(binding);
      return;
    }
    const merged = new Map(result.messages.map(message => [String(message.id), message]));
    for (const [id, message] of live) if (!merged.has(id)) merged.set(id, message);
    const messages = [...merged.values()].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const stream = this.chat.messages.value.find(message => message.kind === 'streaming');
    if (stream) messages.push(stream);
    const removedFromCache = result.removed.filter(id => !merged.has(id));
    this.chat.thread.value = { ...this.chat.thread.value, messages,
      remote: { ...this.bound.value!, cursor: result.cursor, removedFromCache } };
    this.chat.persistThread();
    this.chat.thread.value = { ...this.chat.thread.value, remote: { ...this.bound.value!, removedFromCache: undefined } };
    this.status.value = 'Connected';
    if (this.historyDirty) void this.catchUp(this.bound.value!);
  }

  private async receive(frame: Frame): Promise<void> {
    if (this.disposed) return;
    if (frame.type === 'viewer_disconnected') { this.offline(); return }
    if (frame.type === 'relay_device_ready' && typeof frame.accountId === 'string' && typeof frame.workspaceId === 'string') {
      this.ready({ accountId: frame.accountId, workspaceId: frame.workspaceId });
      return;
    }
    if (this.inventory && frame.requestId === this.inventory) {
      if (frame.type === 'relay_inventory_device' && frame.device) this.inventoryRows.push(frame.device as RemoteDevice);
      if (frame.type === 'relay_inventory_complete') {
        clearTimeout(this.inventoryTimer);
        this.applyInventory();
        this.inventory = '';
      }
      return;
    }
    const b = this.bound.value;
    if (!b || !this.scope || b.accountId !== this.scope.accountId || b.workspaceId !== this.scope.workspaceId
        || frame.conversationId !== b.threadId || (frame.deviceId != null && frame.deviceId !== b.deviceId)) return;

    if (b.pending && frame.userMessageId === b.pending.id) {
      if (frame.type === 'ack' || (frame.type === 'relay_receipt' && frame.accepted === true)) {
        clearTimeout(this.sendTimer);
        const { pending, ...binding } = b;
        this.routing = false;
        const thread = this.chat.thread.value;
        const accepted: Message = { kind: 'user', id: asMessageId(pending.id), text: pending.text, createdAt: Date.now() };
        this.chat.thread.value = { ...thread, remote: binding, messages:
          thread.messages.some(message => message.id === pending.id) ? thread.messages : [...thread.messages, accepted] };
        this.chat.persistThread();
        if (this.chat.thread.value.title === 'New chat') {
          this.chat.renameThread(pending.text.trim().slice(0, 44));
        }
        this.acceptedDraft(pending.text);
        this.note.value = '';
        if (frame.type === 'ack') {
          this.routeBinding = binding;
          this.subscribed = b.threadId;
          this.liveRun = pending.id;
          this.running.value = true;
          await this.catchUp(binding);
        } else this.subscribe(binding);
        return;
      }
      if (frame.type === 'error' && frame.definitelyNotAccepted === true) {
        clearTimeout(this.sendTimer);
        this.routing = false;
        const { pending: _pending, ...binding } = b;
        this.updateBinding(this.subscribed ? binding : undefined);
        this.status.value = this.subscribed ? 'Connected' : 'Offline';
        this.note.value = frame.reason === 'selection_unavailable' ? 'Choose a model available on this device.' : 'Message rejected. Your draft stays here.';
        return;
      }
    }

    if (frame.subscriptionId === this.subscription && this.subscription) {
      clearTimeout(this.subscribeTimer);
      this.subscription = '';
      this.routing = false;
      if (frame.type === 'relay_subscribed') {
        this.subscribed = b.threadId;
        this.liveRun = typeof frame.clientRunId === 'string' ? frame.clientRunId : '';
        this.running.value = !!this.liveRun;
        await this.catchUp(b);
      } else if (frame.type === 'error') {
        this.status.value = frame.reason === 'peer_offline' ? 'Offline' : 'Access unavailable';
      }
      return;
    }
    if (frame.type === 'relay_history_changed' && this.subscribed === b.threadId) {
      if (this.buffer) this.historyDirty = true;
      else void this.catchUp(b);
      return;
    }
    if (this.subscribed !== b.threadId || !this.liveRun || frame.clientRunId !== this.liveRun) return;
    const thread = this.chat.thread.value;
    const stream = asMessageId(`relay-draft:${ this.liveRun }`);
    if (frame.type === 'chunk' && typeof frame.delta === 'string') {
      if (thread.messages.some(message => message.id === stream)) this.chat.updateMessage(stream, { text: frame.delta });
      else this.chat.appendMessage({ kind: 'streaming', id: stream, text: frame.delta, createdAt: Date.now(), startedAt: Date.now() });
    }
    if (['done', 'message'].includes(String(frame.type)) && typeof frame.id === 'string' && typeof frame.content === 'string' && frame.content) {
      this.chat.thread.value = { ...thread, messages: thread.messages.filter(message => message.id !== stream) };
      this.committed({ kind: 'sulla', id: asMessageId(frame.id), text: frame.content, model: '', createdAt: Date.now() });
    }
    if (frame.type === 'done' || frame.type === 'stopped') {
      this.liveRun = '';
      this.running.value = false;
      this.chat.thread.value = { ...this.chat.thread.value, messages: this.chat.messages.value.filter(message => message.id !== stream) };
      if (frame.outcome === 'failed') this.note.value = 'The remote run failed.';
      this.chat.persistThread();
    }
  }
}

/*
  ThreadRegistry — tracks every live ChatController in this window.

  Rationale:
    • Multiple tabs may have chat threads open concurrently.
    • Switching history items should be free (pick a different active
      controller, no re-instantiation).
    • Persistence is thread-scoped; the registry coordinates load/save.

  The registry is the ONLY place that instantiates controllers, so we
  have a single funnel for lifecycle (dispose, persist, hydrate).
*/

import { ref, type Ref } from 'vue';

import { ChatController, type ChatControllerOptions, type ThreadPersister } from './ChatController';
import type { ThreadState } from '../models/Thread';
import type { ThreadId }    from '../types/chat';

export class ThreadRegistry {
  private controllers = new Map<ThreadId, ChatController>();
  readonly activeId: Ref<ThreadId | null> = ref(null);

  constructor(private persister?: ThreadPersister) {}

  /** Create a new thread + controller and make it active. */
  create(opts?: Partial<ChatControllerOptions>): ChatController {
    const ctrl = new ChatController({ ...opts, persister: this.persister });
    this.controllers.set(ctrl.thread.value.id, ctrl);
    this.activeId.value = ctrl.thread.value.id;
    return ctrl;
  }

  /** Hydrate a controller from a stored state. Makes it active. */
  open(state: ThreadState, tabId?: string): ChatController {
    const existing = this.controllers.get(state.thread.id);
    if (existing) {
      this.activeId.value = state.thread.id;
      return existing;
    }
    const ctrl = new ChatController({ hydrateFrom: state, persister: this.persister, tabId });
    this.controllers.set(state.thread.id, ctrl);
    this.activeId.value = state.thread.id;
    return ctrl;
  }

  /** Switch which thread the UI sees. The other stays resident. */
  activate(id: ThreadId): ChatController | null {
    const c = this.controllers.get(id);
    if (!c) return null;
    this.activeId.value = id;
    return c;
  }

  /** Close a thread (disposes the controller; persistence already saved). */
  close(id: ThreadId): void {
    const c = this.controllers.get(id);
    if (!c) return;
    c.dispose();
    this.controllers.delete(id);
    if (this.activeId.value === id) {
      const next = this.controllers.keys().next().value ?? null;
      this.activeId.value = next ?? null;
    }
  }

  /** Get the active controller (or null if none). */
  active(): ChatController | null {
    const id = this.activeId.value;
    return id ? (this.controllers.get(id) ?? null) : null;
  }

  /** Get a controller by id. */
  get(id: ThreadId): ChatController | null {
    return this.controllers.get(id) ?? null;
  }

  /** List all open controllers (for the history rail / tab switcher). */
  all(): ChatController[] {
    return [...this.controllers.values()];
  }

  /** Dispose everything — call on window close. */
  disposeAll(): void {
    for (const c of this.controllers.values()) c.dispose();
    this.controllers.clear();
    this.activeId.value = null;
  }
}

/*
  Hybrid persister: saves to both localStorage (phase-0 fallback) and
  PostgreSQL via IPC (durable backup when localStorage is evicted).

  Keys:
    chat:index              → array of ThreadId
    chat:thread:<ThreadId>  → ThreadState JSON
    chat:tab:<tabId>        → ThreadId (last active thread per tab)
*/

import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import type { ThreadPersister } from '../controller/ChatController';
import type { ThreadState }     from '../models/Thread';
import type { ThreadId }        from '../types/chat';

const INDEX_KEY = 'chat:index';
const KEY = (id: ThreadId) => `chat:thread:${ id }`;
const TAB_KEY = (tabId: string) => `chat:tab:${ tabId }`;

export class LocalStoragePersister implements ThreadPersister {
  save(state: ThreadState): void {
    try {
      localStorage.setItem(KEY(state.thread.id), JSON.stringify(state));
      const index = this.readIndex();
      if (!index.includes(state.thread.id)) {
        index.unshift(state.thread.id);
        localStorage.setItem(INDEX_KEY, JSON.stringify(index));
      }

      // Also save to database via IPC (fire-and-forget)
      // If this fails, we still have localStorage as fallback
      // DISABLED TEMPORARILY: debugging duplicate message issue
      // ipcRenderer.invoke('chat-messages:save', state.thread.id, state)
      //   .catch(err => console.error('[LocalStoragePersister] DB backup save failed:', err));
    } catch (e) { console.error('[LocalStoragePersister] save failed:', e); }
  }

  load(id: ThreadId): ThreadState | null {
    try {
      const raw = localStorage.getItem(KEY(id));
      if (raw) return JSON.parse(raw) as ThreadState;

      // localStorage miss — try to load from database (sync version unavailable)
      // The async fallback is handled in ChatPage.vue's onActivate()
      return null;
    } catch { return null; }
  }

  /**
   * Async load with database fallback (called when localStorage misses).
   * Returns the state from database or null if not found.
   */
  async loadAsync(id: ThreadId): Promise<ThreadState | null> {
    try {
      // Try localStorage first
      const raw = localStorage.getItem(KEY(id));
      if (raw) return JSON.parse(raw) as ThreadState;

      // localStorage miss — load from database
      const result = await ipcRenderer.invoke('chat-messages:load', id);
      if (result.success && result.data) {
        // Restore to localStorage for next time
        try {
          localStorage.setItem(KEY(id), JSON.stringify(result.data));
        } catch (e) {
          // localStorage might be full, but we still have DB data
          console.warn('[LocalStoragePersister] Could not restore to localStorage:', e);
        }
        return result.data as ThreadState;
      }
      return null;
    } catch (err) {
      console.error('[LocalStoragePersister] Async load failed:', err);
      return null;
    }
  }

  list(): ThreadState[] {
    const out: ThreadState[] = [];
    for (const id of this.readIndex()) {
      const s = this.load(id);
      if (s) out.push(s);
    }
    // Most-recently-updated first
    out.sort((a, b) => b.thread.updatedAt - a.thread.updatedAt);
    return out;
  }

  remove(id: ThreadId): void {
    try {
      localStorage.removeItem(KEY(id));
      const index = this.readIndex().filter(x => x !== id);
      localStorage.setItem(INDEX_KEY, JSON.stringify(index));

      // Also delete from database (fire-and-forget)
      ipcRenderer.invoke('chat-messages:delete', id)
        .catch(err => console.error('[LocalStoragePersister] DB delete failed:', err));
    } catch {}
  }

  /** Remember which thread was last active in a given tab. */
  setTabThread(tabId: string, threadId: ThreadId): void {
    try {
      localStorage.setItem(TAB_KEY(tabId), threadId);
    } catch (e) { console.error('[LocalStoragePersister] setTabThread failed:', e); }
  }

  /** Look up the last active thread id for a tab, or null if none. */
  getTabThread(tabId: string): ThreadId | null {
    try {
      const raw = localStorage.getItem(TAB_KEY(tabId));
      return raw ? (raw as ThreadId) : null;
    } catch { return null; }
  }

  /** Forget the tab→thread pointer. Used when the target thread is missing
   *  so subsequent reopens don't keep chasing a stale id. */
  clearTabThread(tabId: string): void {
    try { localStorage.removeItem(TAB_KEY(tabId)); } catch { /* ignore */ }
  }

  private readIndex(): ThreadId[] {
    try {
      const raw = localStorage.getItem(INDEX_KEY);
      return raw ? JSON.parse(raw) as ThreadId[] : [];
    } catch { return []; }
  }
}

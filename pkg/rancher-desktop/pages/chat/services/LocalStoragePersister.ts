/*
  Simple localStorage-backed persister for phase-0. Swap for an
  IPC/IndexedDB-backed persister in production.

  Keys:
    chat:index              → array of ThreadId
    chat:thread:<ThreadId>  → ThreadState JSON
*/

import type { ThreadPersister } from '../controller/ChatController';
import type { ThreadState }     from '../models/Thread';
import type { ThreadId }        from '../types/chat';

const INDEX_KEY = 'chat:index';
const KEY = (id: ThreadId) => `chat:thread:${ id }`;

export class LocalStoragePersister implements ThreadPersister {
  save(state: ThreadState): void {
    try {
      localStorage.setItem(KEY(state.thread.id), JSON.stringify(state));
      const index = this.readIndex();
      if (!index.includes(state.thread.id)) {
        index.unshift(state.thread.id);
        localStorage.setItem(INDEX_KEY, JSON.stringify(index));
      }
    } catch (e) { console.error('[LocalStoragePersister] save failed:', e); }
  }

  load(id: ThreadId): ThreadState | null {
    try {
      const raw = localStorage.getItem(KEY(id));
      return raw ? JSON.parse(raw) as ThreadState : null;
    } catch { return null; }
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
    } catch {}
  }

  private readIndex(): ThreadId[] {
    try {
      const raw = localStorage.getItem(INDEX_KEY);
      return raw ? JSON.parse(raw) as ThreadId[] : [];
    } catch { return []; }
  }
}

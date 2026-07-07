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

// One thread's cache blob may not squeeze every other thread out of
// localStorage. Threads whose JSON exceeds the cap are cached with only the
// most recent messages; the FULL state always goes to the Postgres backup, so
// nothing is lost — older messages just cost a DB round-trip after a reload.
// Sizes are in UTF-16 code units (what the ~5M-unit quota is measured in).
const MAX_THREAD_CACHE_UNITS = 1_500_000;
const CACHE_TAIL_MESSAGES = 60;

// Startup GC target for all chat:thread:* blobs combined. Keeping the chat
// cache under this leaves headroom for tabs/history/theme keys in the same
// origin quota, so the first message of a new thread never lands on a
// quota that is already full.
const CHAT_CACHE_BUDGET_UNITS = 3_500_000;

/** True for a localStorage quota-exceeded failure (name or legacy code 22). */
function isQuotaError(e: unknown): boolean {
  return e instanceof DOMException &&
    (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22);
}

export class LocalStoragePersister implements ThreadPersister {
  constructor() {
    try {
      this.gcOnce();
    } catch (e) { console.warn('[LocalStoragePersister] startup GC failed:', e); }
  }

  save(state: ThreadState): void {
    // Compute the JSON-safe representation ONCE and reuse it for both sinks.
    // JSON.stringify silently drops functions / Vue proxies / non-plain
    // values; the IPC structured-clone algorithm THROWS on them instead
    // ("An object could not be cloned"). Passing the raw reactive `state`
    // over IPC failed whenever a message carried such a field — e.g. a
    // channel message from another agent — even though the localStorage
    // write below succeeded on the same data. Sending the parsed JSON-safe
    // object makes the DB backup persist exactly what localStorage stores,
    // so it can never choke on an un-cloneable field.
    let json: string;

    try {
      json = JSON.stringify(state);
    } catch (e) {
      console.error('[LocalStoragePersister] serialize failed:', e);

      return;
    }

    // Durable sink FIRST, in its own try block. These three writes used to
    // share one try{} in cache→index→DB order, so a full quota threw on the
    // index write and silently skipped the DB save — the message then existed
    // nowhere after a reload (the "blank thread on first message" bug).
    try {
      ipcRenderer.invoke('chat-messages:save', state.thread.id, JSON.parse(json))
        .catch(err => console.error('[LocalStoragePersister] DB backup save failed:', err));
    } catch (e) { console.error('[LocalStoragePersister] DB backup dispatch failed:', e); }

    // Cache copy — capped for oversized threads (full history lives in the DB).
    try {
      let cacheJson = json;

      if (json.length > MAX_THREAD_CACHE_UNITS && Array.isArray(state.thread?.messages)) {
        cacheJson = JSON.stringify({
          ...state,
          thread: { ...state.thread, messages: state.thread.messages.slice(-CACHE_TAIL_MESSAGES) },
        });
        console.warn(`[LocalStoragePersister] thread ${ state.thread.id } cache capped to last ${ CACHE_TAIL_MESSAGES } messages (${ json.length } units > ${ MAX_THREAD_CACHE_UNITS })`);
      }
      this.setItemWithEviction(KEY(state.thread.id), cacheJson, state.thread.id);
    } catch (e) { console.error('[LocalStoragePersister] cache write failed:', e); }

    try {
      const index = this.readIndex();

      if (!index.includes(state.thread.id)) {
        index.unshift(state.thread.id);
        localStorage.setItem(INDEX_KEY, JSON.stringify(index));
      }
    } catch (e) { console.warn('[LocalStoragePersister] index update failed:', e); }
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

  /**
   * Write a thread blob, self-healing when localStorage is full.
   *
   * localStorage has no pruning of its own: the index grows unbounded and every
   * thread ever opened keeps its `chat:thread:*` blob forever. Once the ~5-10MB
   * quota fills, EVERY subsequent write throws QuotaExceededError. We recover by
   * evicting the oldest threads (tail of the newest-first index) and retrying.
   * The durable copy lives in Postgres (chat-messages:save via IPC), so evicting
   * a localStorage blob only costs a DB round-trip on next load, never data.
   */
  private setItemWithEviction(key: string, value: string, keepId: ThreadId): void {
    try {
      localStorage.setItem(key, value);
      return;
    } catch (e) {
      if (!isQuotaError(e)) throw e;
    }

    // Evict oldest threads (tail first) until the write succeeds or we run out.
    const index = this.readIndex().filter(id => id !== keepId);
    for (let i = index.length - 1; i >= 0; i--) {
      const evictId = index[i];
      localStorage.removeItem(KEY(evictId));
      try {
        localStorage.setItem(key, value);
        console.warn(`[LocalStoragePersister] localStorage full — evicted ${ index.length - i } old thread(s) to make room`);
        // Drop the evicted ids from the persisted index so they aren't chased on load.
        const survivors = this.readIndex().filter(id => id === keepId || index.slice(0, i).includes(id));
        try { localStorage.setItem(INDEX_KEY, JSON.stringify(survivors)); } catch { /* index write best-effort */ }
        return;
      } catch (e) {
        if (!isQuotaError(e)) throw e;
        // still full — keep evicting
      }
    }
    // Couldn't fit even after evicting everything else; give up on localStorage.
    // The DB backup below still persists this thread.
    console.warn('[LocalStoragePersister] localStorage still full after evicting all other threads — relying on DB backup');
  }

  private readIndex(): ThreadId[] {
    try {
      const raw = localStorage.getItem(INDEX_KEY);
      return raw ? JSON.parse(raw) as ThreadId[] : [];
    } catch { return []; }
  }

  /**
   * One-shot startup GC. Two jobs:
   *  1. Delete orphaned chat:thread:* blobs — eviction removes blobs and then
   *     rewrites the index best-effort, so a failed index write leaves blobs
   *     that nothing will ever load OR delete. They only accumulate.
   *  2. Enforce a total budget on the chat cache by evicting the oldest
   *     threads (index tail) BEFORE the quota fills, so the next write —
   *     e.g. the first message of a brand-new thread — has room. Deliberately
   *     leaves chat:tab:* pointers alone: they're ~50 bytes and History
   *     restore needs them to reconnect a reopened tab to its thread.
   */
  private gcOnce(): void {
    if (LocalStoragePersister._gcRan) return;
    LocalStoragePersister._gcRan = true;

    const index = this.readIndex();
    const known = new Set<string>(index.map(id => KEY(id)));
    const orphans: string[] = [];

    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('chat:thread:') && !known.has(k)) orphans.push(k);
    }
    // Collect first, remove after — removing while iterating shifts key indexes.
    for (const k of orphans) localStorage.removeItem(k);

    let total = 0;
    const sizes = new Map<ThreadId, number>();

    for (const id of index) {
      const v = localStorage.getItem(KEY(id));
      if (v) {
        sizes.set(id, v.length);
        total += v.length;
      }
    }

    let evicted = 0;

    if (total > CHAT_CACHE_BUDGET_UNITS) {
      const survivors = [...index];

      // Oldest-created threads live at the index tail; keep at least one.
      while (total > CHAT_CACHE_BUDGET_UNITS && survivors.length > 1) {
        const evict = survivors.pop() as ThreadId;

        total -= sizes.get(evict) ?? 0;
        localStorage.removeItem(KEY(evict));
        evicted++;
      }
      try {
        localStorage.setItem(INDEX_KEY, JSON.stringify(survivors));
      } catch { /* best-effort — blobs are gone either way */ }
    }

    if (orphans.length > 0 || evicted > 0) {
      console.warn(`[LocalStoragePersister] startup GC: removed ${ orphans.length } orphaned blob(s), evicted ${ evicted } old thread(s); chat cache now ${ total } units`);
    }
  }

  private static _gcRan = false;
}

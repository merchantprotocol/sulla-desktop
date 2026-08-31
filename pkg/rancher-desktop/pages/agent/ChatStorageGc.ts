// ChatStorageGc.ts
//
// ─── Legacy per-tab storage GC (GW7w) ──────────────────────────────
// Every ChatInterface instance (main chat, side-panel, secretary mode) owns
// a `chat_messages_<scope>` + `chat_has_sent_message_<scope>` pair keyed by
// a random per-tab id. Unlike the newer LocalStoragePersister (chat:thread:*),
// these keys were never indexed, bounded, or cleaned up — a tab closed weeks
// ago kept its blob forever. That unbounded growth is why
// `chat_has_sent_message_*` writes kept throwing QuotaExceededError on
// every session start, which is what surfaced as the chat freeze reports.
const CHAT_SCOPE_INDEX_KEY = 'chat_scope_index';
const MAX_CHAT_SCOPES = 20;
const LEGACY_CACHE_BUDGET_UNITS = 1_500_000;

let legacyScopeGcRan = false;

function evictChatScope(scope: string): void {
  try { localStorage.removeItem(`chat_messages_${ scope }`) } catch { /* best-effort */ }
  try { localStorage.removeItem(`chat_has_sent_message_${ scope }`) } catch { /* best-effort */ }
}

/**
 * Registers `scope` as the most-recently-used chat tab and evicts stale
 * scopes once the live count or aggregate blob size exceeds budget — the
 * same pattern LocalStoragePersister already uses for chat:thread:*. On the
 * very first call in a session it also discovers scopes written before this
 * fix shipped (the index doesn't know about them yet) so pre-existing cruft
 * gets swept too, not just future growth.
 */
export function touchChatStorageScope(scope: string): void {
  let index: string[];
  try {
    const raw = localStorage.getItem(CHAT_SCOPE_INDEX_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    index = Array.isArray(parsed) ? parsed.filter((s: unknown): s is string => typeof s === 'string') : [];
  } catch { index = [] }

  if (!legacyScopeGcRan) {
    legacyScopeGcRan = true;
    const discovered = new Set(index);
    for (let i = 0; i < localStorage.length; i++) {
      const m = localStorage.key(i)?.match(/^chat_messages_(.+)$/);
      if (m) discovered.add(m[1]);
    }
    index = [...discovered];
  }

  index = [scope, ...index.filter(s => s !== scope)];

  let total = 0;
  const sizes = new Map<string, number>();
  for (const s of index) {
    const size = (localStorage.getItem(`chat_messages_${ s }`)?.length ?? 0) +
      (localStorage.getItem(`chat_has_sent_message_${ s }`)?.length ?? 0);
    sizes.set(s, size);
    total += size;
  }

  while ((index.length > MAX_CHAT_SCOPES || total > LEGACY_CACHE_BUDGET_UNITS) && index.length > 1) {
    const evicted = index.pop()!;
    total -= sizes.get(evicted) ?? 0;
    evictChatScope(evicted);
  }

  try { localStorage.setItem(CHAT_SCOPE_INDEX_KEY, JSON.stringify(index)) } catch { /* best-effort */ }
}

/** Test-only: reset the once-per-session discovery guard. */
export function _resetLegacyScopeGcForTests(): void {
  legacyScopeGcRan = false;
}

/**
 * SullaSyncService — periodic push + pull with sulla-workers.
 *
 * Mirrors sulla-mobile/src/services/SyncService.ts:
 *   - push()  : POST /sync/push with queued local mutations, clear queue on success
 *   - pull()  : GET /sync/pull?after=<seq>, apply items via syncHandlers, advance cursor
 *   - fullSync() : push then pull, one at a time (no overlap)
 *
 * Runs in the Electron main process. Started by sullaCloudAuth when the
 * user signs in, stopped on sign-out. Uses getCurrentAccessToken() for auth
 * (auto-refreshes tokens near expiry) so we never send a stale bearer.
 *
 * No external dependency beyond the Sulla cloud — if the worker or the
 * access token are unavailable, the cycle logs a warning and tries again
 * on the next tick.
 */

import { getCurrentAccessToken } from '@pkg/main/sullaCloudAuth';
import Logging from '@pkg/utils/logging';

import { syncHandlers, type SyncItem } from './syncHandlers';
import { mirrorMessageToClaudeMessages } from './syncMirror';
import { clearOps, getPendingOps } from './syncQueue';
import { getLastSeq, setLastSeq } from './syncMeta';

const log = Logging.background;

const API_BASE = 'https://sulla-workers.jonathon-44b.workers.dev';
const POLL_INTERVAL_MS = 15_000;
const PUSH_DEBOUNCE_MS = 300;

interface PullResponse {
  items: Array<{
    seq:       number;
    dataType:  string;
    entityId:  string;
    payload:   string; // JSON string
    createdAt: string;
  }>;
  lastSeq: number;
  hasMore: boolean;
}

interface PushResponse {
  pushed?:  number;
  applied?: number;
}

class SullaSyncServiceImpl {
  private syncing = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pushDebounce: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private loggerListener: ((payload: { conversationId: string; event: any }) => void) | null = null;

  isRunning(): boolean {
    return this.running;
  }

  isSyncing(): boolean {
    return this.syncing;
  }

  /** Called by sullaCloudAuth on successful sign-in. Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    log.log('[SullaSync] Starting sync loop');
    this.attachLoggerMirror();
    this.fullSync().catch((err) => {
      log.warn('[SullaSync] Initial sync failed:', err);
    });
    this.pollTimer = setInterval(() => {
      this.fullSync().catch((err) => {
        log.warn('[SullaSync] Periodic sync failed:', err);
      });
    }, POLL_INTERVAL_MS);
  }

  /** Called by sullaCloudAuth on sign-out. Idempotent. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    log.log('[SullaSync] Stopping sync loop');
    this.detachLoggerMirror();
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.pushDebounce) {
      clearTimeout(this.pushDebounce);
      this.pushDebounce = null;
    }
  }

  /**
   * Subscribe to SullaLogger's `event` emitter so every desktop-originated
   * user/assistant turn on a primary chat thread gets mirrored into the
   * claude_messages / claude_conversations tables. The mirror itself filters
   * out subagent / workflow / streaming chatter — this just forwards.
   */
  private attachLoggerMirror(): void {
    if (this.loggerListener) return;
    this.loggerListener = ({ conversationId, event }) => {
      if (!event || event.type !== 'message') return;
      const role = String(event.role ?? '');
      const content = String(event.content ?? '');
      const ts = String(event.ts ?? new Date().toISOString());
      mirrorMessageToClaudeMessages({ conversationId, role, content, ts }).catch((err) => {
        log.warn('[SullaSync] mirror failed:', err);
      });
    };
    try {
      // Lazy-require to avoid a circular dependency at module load time.
      const { getSullaLogger } = require('@pkg/agent/services/SullaLogger') as typeof import('@pkg/agent/services/SullaLogger');
      getSullaLogger().on('event', this.loggerListener);
    } catch (err) {
      log.warn('[SullaSync] attachLoggerMirror failed:', err);
      this.loggerListener = null;
    }
  }

  private detachLoggerMirror(): void {
    if (!this.loggerListener) return;
    try {
      const { getSullaLogger } = require('@pkg/agent/services/SullaLogger') as typeof import('@pkg/agent/services/SullaLogger');
      getSullaLogger().off('event', this.loggerListener);
    } catch { /* ignore */ }
    this.loggerListener = null;
  }

  /**
   * Schedule an eager push shortly after the current tick. Used by the
   * dispatcher after writing an assistant reply so the mobile client
   * doesn't have to wait up to POLL_INTERVAL_MS to see it.
   */
  pushSoon(): void {
    if (!this.running) return;
    if (this.pushDebounce) return;
    this.pushDebounce = setTimeout(() => {
      this.pushDebounce = null;
      this.fullSync().catch((err) => {
        log.warn('[SullaSync] pushSoon sync failed:', err);
      });
    }, PUSH_DEBOUNCE_MS);
  }

  async fullSync(): Promise<{ pushed: number; pulled: number }> {
    if (this.syncing) return { pushed: 0, pulled: 0 };
    if (!this.running) return { pushed: 0, pulled: 0 };

    this.syncing = true;
    try {
      const pushed = await this.push();
      const pulled = await this.pull();
      return { pushed, pulled };
    } finally {
      this.syncing = false;
    }
  }

  private async authedFetch(path: string, init?: RequestInit): Promise<Response | null> {
    const token = await getCurrentAccessToken();
    if (!token) {
      // Not signed in — sync is effectively disabled until the user auths.
      return null;
    }
    try {
      return await fetch(`${ API_BASE }${ path }`, {
        ...init,
        headers: {
          'Content-Type':  'application/json',
          Authorization:   `Bearer ${ token }`,
          ...(init?.headers as Record<string, string> | undefined),
        },
      });
    } catch (err) {
      log.warn(`[SullaSync] fetch ${ path } failed:`, err);
      return null;
    }
  }

  async push(): Promise<number> {
    const ops = await getPendingOps(500);
    if (ops.length === 0) return 0;

    const items: SyncItem[] = [];
    const processedIds: string[] = [];

    for (const op of ops) {
      const handler = syncHandlers[op.table_name];
      if (!handler) {
        log.log(`[SullaSync] no handler for ${ op.table_name }, dropping`);
        processedIds.push(op.id);
        continue;
      }

      let recordKey: Record<string, unknown>;
      try {
        recordKey = JSON.parse(op.record_key);
      } catch {
        processedIds.push(op.id);
        continue;
      }

      if (op.operation === 'delete') {
        items.push({
          dataType:  op.table_name,
          entityId:  typeof recordKey.id === 'string' ? recordKey.id : JSON.stringify(recordKey),
          payload:   JSON.stringify({ ...recordKey, deleted: true }),
          updatedAt: op.created_at,
          deleted:   true,
        });
        processedIds.push(op.id);
        continue;
      }

      const item = await handler.readLocal(recordKey);
      if (item) items.push(item);
      processedIds.push(op.id);
    }

    if (items.length === 0) {
      if (processedIds.length > 0) await clearOps(processedIds);
      return 0;
    }

    const res = await this.authedFetch('/sync/push', {
      method: 'POST',
      body:   JSON.stringify({ items }),
    });

    if (!res || !res.ok) {
      log.warn(`[SullaSync] push failed, status=${ res?.status ?? 'no-response' }`);
      return 0;
    }

    try {
      await res.json() as PushResponse;
    } catch { /* ignore body parse failures */ }

    await clearOps(processedIds);
    log.log(`[SullaSync] pushed ${ items.length } items`);
    return items.length;
  }

  async pull(): Promise<number> {
    let totalPulled = 0;
    let hasMore = true;
    let safety = 10; // max 10 pagination rounds per cycle

    while (hasMore && safety-- > 0) {
      const afterSeq = await getLastSeq();
      const res = await this.authedFetch(`/sync/pull?after=${ afterSeq }`);
      if (!res || !res.ok) {
        log.warn(`[SullaSync] pull failed, status=${ res?.status ?? 'no-response' } after=${ afterSeq }`);
        break;
      }

      let data: PullResponse;
      try {
        data = await res.json() as PullResponse;
      } catch {
        log.warn('[SullaSync] pull response JSON parse failed');
        break;
      }

      const items = data.items ?? [];
      hasMore = !!data.hasMore;
      if (items.length === 0) break;

      let highest = afterSeq;
      // Need the active contractor id for handlers that don't embed it in
      // the payload. We fall back to the payload's contractor_id column.
      const { getActiveContractorId } = await import('@pkg/main/sullaCloudAuth');
      const contractorId = await getActiveContractorId();

      for (const item of items) {
        const handler = syncHandlers[item.dataType];
        if (!handler) {
          highest = Math.max(highest, item.seq);
          continue;
        }

        try {
          const payload = JSON.parse(item.payload);
          await handler.applyRemote(
            {
              dataType:  item.dataType,
              entityId:  item.entityId,
              payload:   JSON.stringify(payload),
              updatedAt: item.createdAt,
              deleted:   !!payload.deleted || !!payload.deleted_at,
            },
            contractorId,
          );
          highest = Math.max(highest, item.seq);
        } catch (err) {
          log.warn(`[SullaSync] applyRemote failed for ${ item.dataType }/${ item.entityId } seq=${ item.seq }:`, err);
          // Don't advance past the failed item — retry next cycle
          hasMore = false;
          break;
        }
      }

      if (highest > afterSeq) {
        await setLastSeq(highest);
      }
      totalPulled += items.length;
    }

    if (totalPulled > 0) {
      log.log(`[SullaSync] pulled ${ totalPulled } items`);
    }
    return totalPulled;
  }
}

export const SullaSync = new SullaSyncServiceImpl();

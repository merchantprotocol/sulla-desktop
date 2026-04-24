/**
 * ApprovalService — the single source of truth for pending user-approval
 * requests.
 *
 * This service is intentionally transport-agnostic. It tracks pending
 * approval promises keyed by a generated `approvalId`; the CALLER (a
 * tool, or any backend piece that wants to ask the user something) is
 * responsible for emitting the matching chat message over its own
 * WebSocket / IPC channel. Keeping emission separate from tracking lets
 * any future surface (tool execution gate, workflow node gate, vault
 * gate, etc.) share one resolver map.
 *
 * Lifecycle of one approval:
 *   1. Caller generates an approvalId via `newApprovalId()`
 *   2. Caller emits a `kind: 'tool_approval'` chat message carrying that
 *      approvalId as part of its structured payload
 *   3. Caller awaits `parkPending(approvalId, timeoutMs)`
 *   4. The user clicks approve/deny in the chat UI
 *   5. The renderer sends an IPC message `approval:resolve { approvalId,
 *      decision }` back to main
 *   6. The IPC handler calls `ApprovalService.getInstance().resolve(...)`
 *   7. The pending promise settles; the caller continues
 *
 * Timeout → auto-denies with `{ decision: 'timed_out' }`. 5 minutes by
 * default, configurable per call.
 */

// ─── Types ──────────────────────────────────────────────────────

export interface ApprovalOrigin {
  /** Which subsystem asked. Used for future batch/always-allow grouping. */
  kind:
    | 'tool'
    | 'workflow'
    | 'vault'
    | 'function'
    | 'integration'
    | 'request_user_input';
  [field: string]: unknown;
}

export interface ApprovalDecision {
  decision: 'approved' | 'denied' | 'timed_out';
  /** Free-form note the user may attach when denying. */
  note?:    string;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

interface PendingEntry {
  resolve:  (decision: ApprovalDecision) => void;
  timer:    ReturnType<typeof setTimeout>;
  origin:   ApprovalOrigin;
  createdAt: number;
}

// ─── Service ────────────────────────────────────────────────────

export class ApprovalService {
  private static _instance: ApprovalService | null = null;
  private readonly pending = new Map<string, PendingEntry>();

  static getInstance(): ApprovalService {
    if (!this._instance) this._instance = new ApprovalService();
    return this._instance;
  }

  /** Generate a fresh approval id. Callers include this id in the
   *  ToolApprovalMessage they emit so the renderer can bounce it back
   *  to `resolve()` when the user clicks a button. */
  newApprovalId(): string {
    const rand = Math.random().toString(36).slice(2, 10);
    return `appr_${ Date.now() }_${ rand }`;
  }

  /** Park a pending promise for the given approvalId. Timeout fires an
   *  implicit `timed_out` decision — safer default than allowing a
   *  stranded action through. */
  parkPending(approvalId: string, origin: ApprovalOrigin, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<ApprovalDecision> {
    // Defensive: if a caller accidentally reuses an id, resolve the old
    // one as timed_out before overwriting.
    const existing = this.pending.get(approvalId);
    if (existing) {
      clearTimeout(existing.timer);
      existing.resolve({ decision: 'timed_out' });
      this.pending.delete(approvalId);
    }

    return new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(approvalId)) {
          resolve({ decision: 'timed_out' });
        }
      }, timeoutMs);

      this.pending.set(approvalId, {
        resolve,
        timer,
        origin,
        createdAt: Date.now(),
      });
    });
  }

  /**
   * Settle a pending approval. Returns true when the id matched an
   * outstanding request, false when it didn't (stale resolution, double
   * click, etc.).
   */
  resolve(approvalId: string, decision: 'approved' | 'denied', note?: string): boolean {
    const entry = this.pending.get(approvalId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(approvalId);
    entry.resolve({ decision, note });
    return true;
  }

  /** Test / debug helper. Not for production call-sites. */
  pendingCount(): number {
    return this.pending.size;
  }
}

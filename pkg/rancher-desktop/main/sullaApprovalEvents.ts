/**
 * Sulla approval IPC handlers.
 *
 *   approval:resolve → settle a pending approval promise in the main
 *                      process. Fired from the renderer when the user
 *                      clicks approve/deny on a ToolApproval card.
 *
 * Returns `{ settled: boolean }` — `false` when the approvalId didn't
 * match an outstanding request (already resolved, already timed out,
 * double-clicked, etc.). The renderer should treat either outcome as
 * "decision recorded" — the UI-side decision flip is authoritative for
 * the transcript; this handler just releases the blocked backend tool.
 */
import { ApprovalService } from '@pkg/agent/services/ApprovalService';
import { getIpcMainProxy } from '@pkg/main/ipcMain';

const ipcMainProxy = getIpcMainProxy(console);

export function initSullaApprovalEvents(): void {
  ipcMainProxy.handle('approval:resolve', async(_event: unknown, payload: { approvalId?: string; decision?: string; note?: string }) => {
    const approvalId = typeof payload?.approvalId === 'string' ? payload.approvalId.trim() : '';
    const decision = payload?.decision;
    const note = typeof payload?.note === 'string' ? payload.note : undefined;

    if (!approvalId) return { settled: false, reason: 'missing approvalId' };
    if (decision !== 'approved' && decision !== 'denied') {
      return { settled: false, reason: `invalid decision "${ String(decision) }"` };
    }

    const settled = ApprovalService.getInstance().resolve(approvalId, decision, note);
    return { settled };
  });
}

/**
 * Sulla approval IPC handlers.
 *
 *   approval:resolve → settle a pending approval promise in the main
 *                      process. Fired from the renderer when the user
 *                      clicks approve/deny on a ToolApproval card.
 *   question:resolve → settle a pending question promise. Fired from the
 *                      renderer when the user answers a ToolQuestion card.
 *
 * Returns `{ settled: boolean }` — `false` when the id didn't match an
 * outstanding request (already resolved, already timed out, double-clicked,
 * etc.). The renderer should treat either outcome as "decision recorded" —
 * the UI-side flip is authoritative for the transcript; these handlers just
 * release the blocked backend tool.
 */
import { ApprovalService, type UserQuestionAnswerItem } from '@pkg/agent/services/ApprovalService';
import { getIpcMainProxy } from '@pkg/main/ipcMain';
import Logging from '@pkg/utils/logging';

const console = Logging.background;
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

  ipcMainProxy.handle('question:resolve', async(_event: unknown, payload: { questionId?: string; answers?: unknown }) => {
    const questionId = typeof payload?.questionId === 'string' ? payload.questionId.trim() : '';
    if (!questionId) return { settled: false, reason: 'missing questionId' };

    // Sanitize the answers array — { question, selected[] } items only.
    const rawAnswers = Array.isArray(payload?.answers) ? payload.answers : [];
    const answers: UserQuestionAnswerItem[] = rawAnswers
      .map((a: any) => ({
        question: typeof a?.question === 'string' ? a.question : '',
        selected: Array.isArray(a?.selected)
          ? a.selected.filter((s: any) => typeof s === 'string' && s.trim()).map((s: string) => s.trim())
          : [],
      }))
      .filter((a: UserQuestionAnswerItem) => a.selected.length > 0);

    const settled = ApprovalService.getInstance().resolveQuestion(questionId, answers);
    return { settled };
  });
}

// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { BrowserWindow } from 'electron';
import { DecisionExpirySweeper } from '@pkg/agent/services/DecisionExpirySweeper';
import { decisionService } from '@pkg/agent/services/DecisionService';
import { toolRegistry } from '@pkg/agent/tools';
import { toolRuntime } from '@pkg/agent/tools/toolRuntime';
import { FilesPublishDecisionApplier } from './FilesPublishDecisionApplier';
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
  decisionService.subscribe(record => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && /^(file:|app:)/.test(window.webContents.getURL())) window.webContents.send('decisions:changed', record);
    }
  });
  // Agent file publish requests: once the human decides in Decide or chat,
  // apply that same decision to Files as the human (agents cannot publish).
  const filePublishApplier = new FilesPublishDecisionApplier(
    decisionService,
    async() => {
      const { getSullaFilesClient } = await import('@pkg/main/sullaFilesClient');
      return getSullaFilesClient();
    },
    (message, error) => error === undefined ? console.error(message) : console.error(message, error),
  );
  filePublishApplier.start();
  // Both listeners must be subscribed before the first sweep: an approval that expired while the
  // app was closed is announced once, and that announcement rejects it in Files and tells its asker.
  toolRuntime.start();
  new DecisionExpirySweeper(decisionService, undefined, (message, error) => console.error(message, error)).start();
  const trusted = (event: Electron.IpcMainInvokeEvent) => {
    if (!BrowserWindow.fromWebContents(event.sender) || event.senderFrame !== event.sender.mainFrame ||
        !/^(file:|app:)/.test(event.senderFrame?.url || '')) throw new Error('Only the Desktop application can decide.');
  };
  ipcMainProxy.handle('decisions:list', async(event) => { trusted(event); return decisionService.list(); });
  ipcMainProxy.handle('decisions:conversation', async(event, conversationId, before) => { trusted(event); return decisionService.listForConversation(conversationId, before); });
  ipcMainProxy.handle('decisions:transcript', (event, conversationId, ids) => { trusted(event); return decisionService.listTranscriptDecisions(conversationId, ids); });
  ipcMainProxy.handle('decisions:dismiss', async(event, id, conversationId) => { trusted(event); return decisionService.dismiss(id, conversationId) });
  ipcMainProxy.handle('decisions:resolve', async(event, response) => { trusted(event); return decisionService.resolve(response) });
  ipcMainProxy.handle('decisions:policies', async(event) => {
    trusted(event);
    const required = new Set(await decisionService.policies());
    return toolRegistry.getCategories().flatMap(category => toolRegistry.getToolNamesForCategory(category)
      .filter(name => name !== 'ask_user_question')
      .map(name => ({ name, category, description: toolRegistry.getToolDescription(name), required: required.has(name) })));
  });
  ipcMainProxy.handle('decisions:set-policy', async(event, name, required) => {
    trusted(event);
    if (typeof required !== 'boolean' || name === 'ask_user_question' || !toolRegistry.getCategories().some(c => toolRegistry.getToolNamesForCategory(c).includes(name))) throw new Error('Unknown tool or invalid policy');
    await decisionService.setPolicy(name, required);
    return { saved: true };
  });

  ipcMainProxy.handle('approval:resolve', async(event, payload: { approvalId?: string; decision?: string; note?: string }) => {
    trusted(event);
    const approvalId = typeof payload?.approvalId === 'string' ? payload.approvalId.trim() : '';
    const decision = payload?.decision;
    const note = typeof payload?.note === 'string' ? payload.note : undefined;

    if (!approvalId) return { settled: false, reason: 'missing approvalId' };
    if (decision !== 'approved' && decision !== 'denied') {
      return { settled: false, reason: `invalid decision "${ String(decision) }"` };
    }

    const record = await decisionService.find(approvalId);
    if (record) throw new Error('Use decisions:resolve');
    const settled = ApprovalService.getInstance().resolve(approvalId, decision, note);
    return { settled };
  });

  ipcMainProxy.handle('question:resolve', async(event, payload: { questionId?: string; answers?: unknown }) => {
    trusted(event);
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

    const record = await decisionService.find(questionId);
    if (record) return decisionService.resolve({ id: questionId, conversationId: record.conversationId, action: 'answered', answers });
    const settled = ApprovalService.getInstance().resolveQuestion(questionId, answers);
    return { settled };
  });
}

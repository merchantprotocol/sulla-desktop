// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { FilesTool } from './common';
import { decisionService } from '../../services/DecisionService';
import { PublishApprovalCoordinator } from './PublishApprovalCoordinator';
import type { PublishApprovalRouter } from './PublishApprovalRouter';
import { PublishApprovalRootChatSender, type PublishApprovalCardSender } from './PublishApprovalRootChatSender';
import { toolRuntime } from '../toolRuntime';
import type { ToolResponse } from '../base';
import type { DecisionService } from '../../services/DecisionService';
import type { DecisionRecord } from '@pkg/shared/decisions';

export class FilesRequestPublishWorker extends FilesTool {
  constructor(
    private readonly approvalCoordinator: PublishApprovalCoordinator = toolRuntime.publishApprovalCoordinator,
    private readonly decisions: Pick<DecisionService, 'pendingApprovalForPayload' | 'request'> = decisionService,
    private readonly router: PublishApprovalRouter = toolRuntime.publishApprovalRouter,
    private readonly rootChat: PublishApprovalCardSender = new PublishApprovalRootChatSender(),
  ) {
    super();
    this.approvalCoordinator.start();
  }
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    if (!input.file_id || !input.version_id) throw new Error('file_id and version_id are required');
    // Check the calling conversation before creating a Files publish request,
    // so a refused call never leaves an orphan request behind.
    const callerMetadata = (this.state as any)?.metadata ?? {};
    const conversationId = this.context(input).thread_id;
    if (typeof conversationId !== 'string' || !conversationId.trim()) throw new Error('Approval requires the original conversation. No action was executed.');
    const boundThreadId = typeof callerMetadata.threadId === 'string' ? callerMetadata.threadId.trim() : '';
    if (boundThreadId && boundThreadId !== conversationId) throw new Error('Approval transport does not match the original conversation. No action was executed.');
    const callerChannel = typeof callerMetadata.wsChannel === 'string' && callerMetadata.wsChannel ? callerMetadata.wsChannel : 'sulla-desktop';
    const requestedBy = await this.router.requester(conversationId);
    const draft = await this.containerJson<{ file?: { path?: string }; content_base64?: string }>(`/v1/agent-files/${ encodeURIComponent(input.file_id) }?versionId=${ encodeURIComponent(input.version_id) }`, input);
    const path = draft.file?.path ?? `file ${ input.file_id }`;
    const match = /^(?:Sulla\/)?Use Cases\/(agents|skills|workflows|functions|recipes)\/([^/]+)/.exec(path);
    let label = path;
    if (match) {
      let version = 'draft';
      try {
        const text = Buffer.from(draft.content_base64 ?? '', 'base64').toString('utf8');
        const parsed = path.endsWith('.yaml') || path.endsWith('.yml') ? (await import('yaml')).parse(text) : path.endsWith('.json') ? JSON.parse(text) : {};
        version = String(parsed?.version ?? parsed?.metadata?.version ?? 'draft');
      } catch { /* title remains useful without parsing untrusted draft content */ }
      label = `Activate ${ match[1].slice(0, -1) } '${ match[2] }' v${ version }`;
    }
    const request = await this.containerJson<{ id?: string; requestId?: string }>(`/v1/files/${ encodeURIComponent(input.file_id) }/versions/${ encodeURIComponent(input.version_id) }/publish-request`, input, {
      method: 'POST',
      body: JSON.stringify({ reason: input.reason }),
    });
    const requestId = request?.id || request?.requestId;
    if (!requestId) throw new Error('Files service did not return a publish request id');
    const metadata = (this.state as any)?.metadata ?? {};
    const pending = await this.decisions.pendingApprovalForPayload('filesPublishRequestId', requestId);
    if (pending) {
      if (pending.conversationId !== conversationId) throw new Error('This file version already has an approval pending in its original conversation. No approval was moved or executed.');
      await this.emitApprovalMessage(pending);
      return { successBoolean: true, responseString: JSON.stringify({ request_id: requestId, decision_id: pending.id, status: 'pending' }) };
    }
    const { record } = await this.decisions.request({
      kind: 'approval',
      title: `${ label }?`,
      toolName: 'files_request_publish',
      conversationId,
      channel: callerChannel,
      payload: { filesPublishRequestId: requestId, fileId: input.file_id, versionId: input.version_id },
      requestedBy,
      approvalPresentation: {
        reason: 'Publishing this draft will make it available to agents.',
        command: 'Files draft publication',
        origin: { kind: 'files_publish' },
      },
    }, 7 * 24 * 60 * 60_000);
    await this.emitApprovalMessage(record);
    return { successBoolean: true, responseString: JSON.stringify({ request_id: requestId, decision_id: record.id, status: 'pending' }) };
  }

  private async emitApprovalMessage(record: DecisionRecord): Promise<void> {
    const toolApproval = {
      approvalId: record.id,
      title: record.title,
      expiresAt: record.expiresAt,
      reason: record.approvalPresentation?.reason ?? 'Publishing this draft will make it available to agents.',
      command: record.approvalPresentation?.command ?? 'Files draft publication',
      origin: record.approvalPresentation?.origin ?? { kind: 'files_publish' },
    };
    const target = await this.router.cardTarget(record);
    const delivered = target.kind === 'requester_chat'
      ? await this.emitMessage('', 'tool_approval', { toolApproval })
      : await this.rootChat.send({ channel: target.channel, threadId: target.threadId }, toolApproval);
    if (!delivered) throw new Error(`Files publish request ${ record.id } was saved, but its inline approval card could not be delivered. It remains available in Decide.`);
  }
}

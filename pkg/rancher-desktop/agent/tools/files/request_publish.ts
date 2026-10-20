import { FilesTool } from './common';
import { decisionService } from '../../services/DecisionService';
import { filesContainerJson } from '../../files/containerClient';
import type { ToolResponse } from '../base';

const pending = new Set<string>();
const notify = new Map<string, (message: string) => Promise<boolean>>();

// Resolution happens in Desktop main after the tool has returned. This keeps an
// agent run from sitting on a 30-minute DecisionService promise.
decisionService.subscribe(record => {
  const payload = record.payload;
  if (!payload?.filesPublishRequestId || record.kind !== 'approval' || record.status === 'pending' || record.status === 'deferred') return;
  const key = record.id;
  if (pending.has(key)) return;
  pending.add(key);
  void (async() => {
    try {
      // The Files approve/reject call itself runs as the human in
      // main/sullaApprovalEvents.ts; agent identities cannot publish.
      const send = notify.get(key);
      if (send) await send(record.status === 'approved' ? 'File version publish approved.' : `File version publish request ${ record.status }.`);
    } finally {
      pending.delete(key);
      notify.delete(key);
    }
  })();
});

export class FilesRequestPublishWorker extends FilesTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    if (!input.file_id || !input.version_id) throw new Error('file_id and version_id are required');
    const request = await this.containerJson<{ id?: string; requestId?: string }>(`/v1/files/${ encodeURIComponent(input.file_id) }/versions/${ encodeURIComponent(input.version_id) }/publish-request`, input, {
      method: 'POST',
      body: JSON.stringify({ reason: input.reason }),
    });
    const requestId = request?.id || request?.requestId;
    if (!requestId) throw new Error('Files service did not return a publish request id');
    const metadata = (this.state as any)?.metadata ?? {};
    const { record } = await decisionService.request({
      kind: 'approval',
      title: `Publish file version ${ input.version_id }?`,
      toolName: 'files_request_publish',
      conversationId: metadata.threadId || '',
      channel: metadata.wsChannel || 'sulla-desktop',
      payload: { filesPublishRequestId: requestId, fileId: input.file_id, versionId: input.version_id },
    }, 30 * 60_000);
    notify.set(record.id, message => this.emitMessage(message, 'file_publish_result'));
    await this.emitMessage(`Publish request ${ record.id } is waiting in Decide.`, 'file_publish_request', { decision: record });
    return { successBoolean: true, responseString: JSON.stringify({ request_id: requestId, decision_id: record.id, status: 'pending' }) };
  }
}

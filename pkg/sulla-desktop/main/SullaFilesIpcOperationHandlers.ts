// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { SullaFilesIpcApi, SullaFilesIpcRegistrar } from './SullaFilesIpcSupport';
import type { FilesOperationRequest, FilesOperationRetry, FilesSaveSuccess, FilesTrashItem } from '@pkg/pages/files/types';

const RESIDENCY_TRANSFER_TIMEOUT_MS = 30 * 60_000;

/** Durable database operations, content saves, trash, versions, records management and residency. */
export class SullaFilesIpcOperationHandlers {
  constructor(private readonly api:SullaFilesIpcApi) {}

  /** Database file operations, registered right after the folder tree as before. */
  registerOperations(ipc:SullaFilesIpcRegistrar):void {
    const json = this.api.json.bind(this.api);
    ipc.handle('sulla-files:operation-capabilities', (_event, input:{ collectionId:string }) => json(`/v1/database-file-operations/capabilities?collectionId=${ encodeURIComponent(input.collectionId) }`));
    ipc.handle('sulla-files:folder-operation-state', (_event, input:{ collectionId:string; path:string }) => this.api.client.folderOperationState(input.collectionId, input.path));
    ipc.handle('sulla-files:operation-submit', (_event, input:FilesOperationRequest) => json('/v1/database-file-operations', { method: 'POST', body: JSON.stringify(input) }));
    ipc.handle('sulla-files:operation-status', (_event, input:{ operationId:string }) => json(`/v1/database-file-operations/${ encodeURIComponent(input.operationId) }`));
    ipc.handle('sulla-files:operation-cancel', (_event, input:{ operationId:string }) => json(`/v1/database-file-operations/${ encodeURIComponent(input.operationId) }/cancel`, { method: 'POST', body: '{}' }));
    ipc.handle('sulla-files:operation-retry', (_event, input:{ operationId:string; request:FilesOperationRetry }) => json(`/v1/database-file-operations/${ encodeURIComponent(input.operationId) }/retry`, { method: 'POST', body: JSON.stringify(input.request) }));
    ipc.handle('sulla-files:operation-undo', (_event, input:{ operationId:string }) => json(`/v1/database-file-operations/${ encodeURIComponent(input.operationId) }/undo`, { method: 'POST', body: '{}' }));
  }

  register(ipc:SullaFilesIpcRegistrar):void {
    const json = this.api.json.bind(this.api);
    // A 409 is returned as data: Electron IPC drops custom error fields, and the editor needs currentVersionId to resolve the conflict.
    ipc.handle('sulla-files:save-content', async(_event, input:{ fileId:string; baseVersionId:string; content:string }) => {
      const response = await this.api.client.request(`/v1/files/${ encodeURIComponent(input.fileId) }/content`, { method: 'PUT', body: JSON.stringify({ baseVersionId: input.baseVersionId, content: input.content }) });
      const body = await response.json().catch(() => ({})) as { error?:string; code?:string; currentVersionId?:string };
      if (response.status === 409) return { conflict: { code: 'VERSION_CONFLICT' as const, error: body.error ?? 'This file changed elsewhere.', currentVersionId: body.currentVersionId ?? '' } };
      if (!response.ok) throw new Error(body.error ?? `Files save failed (${ response.status })`);

      return body as FilesSaveSuccess;
    });
    ipc.handle('sulla-files:upload', (_event, input:{ collectionId:string; path:string; mime?:string; data:Uint8Array }) => json(`/v1/files/upload?collectionId=${ encodeURIComponent(input.collectionId) }&path=${ encodeURIComponent(input.path) }`, { method: 'PUT', headers: { 'content-type': input.mime ?? 'application/octet-stream' }, body: Buffer.from(input.data) }));
    ipc.handle('sulla-files:trash', (_event, input:{ fileId:string }) => json(`/v1/files/${ encodeURIComponent(input.fileId) }`, { method: 'DELETE' }));
    ipc.handle('sulla-files:trash-list', (_event, input:{ collectionId:string }) => json(`/v1/trash?collectionId=${ encodeURIComponent(input.collectionId) }`));
    ipc.handle('sulla-files:trash-restore', (_event, input:{ id:string; kind:FilesTrashItem['kind']; expectedRevision:string; currentTombstone:{ id:string; receiptId?:string } }) =>
      json(`/v1/trash/${ encodeURIComponent(input.id) }/restore`, { method: 'POST', body: JSON.stringify({ kind: input.kind, expectedRevision: input.expectedRevision, currentTombstone: input.currentTombstone }) }));
    ipc.handle('sulla-files:trash-purge', (_event, input:{ id:string; kind?:'folder'; expectedRevision:string; currentTombstone:{ id:string; kind?:'receipt'; receiptId?:string }; invalidateUndo?:true }) =>
      json(`/v1/trash/${ encodeURIComponent(input.id) }/purge`, { method: 'DELETE', body: JSON.stringify({ ...(input.kind ? { kind: input.kind } : {}), expectedRevision: input.expectedRevision, currentTombstone: input.currentTombstone, ...(input.invalidateUndo ? { invalidateUndo: true } : {}) }) }));
    ipc.handle('sulla-files:restore-version', (_event, input:{ fileId:string; versionId:string }) => json(`/v1/files/${ encodeURIComponent(input.fileId) }/restore`, { method: 'POST', body: JSON.stringify({ versionId: input.versionId }) }));
    ipc.handle('sulla-files:lifecycle', (_event, input:{ fileId:string; settings:Record<string, unknown> }) => json(`/v1/files/${ encodeURIComponent(input.fileId) }/lifecycle`, { method: 'PATCH', body: JSON.stringify(input.settings) }));
    ipc.handle('sulla-files:checkout', (_event, input:{ fileId:string; force?:boolean }) => json(`/v1/files/${ encodeURIComponent(input.fileId) }/checkout`, { method: input.force ? 'DELETE' : 'POST', body: input.force ? JSON.stringify({ force: true }) : undefined }));
    ipc.handle('sulla-files:checkin', (_event, input:{ fileId:string; versionId:string; kind:'major'|'minor'; comment:string; publish:boolean }) => json(`/v1/files/${ encodeURIComponent(input.fileId) }/checkin`, { method: 'POST', body: JSON.stringify({ versionId: input.versionId, kind: input.kind, comment: input.comment, publish: input.publish }) }));
    ipc.handle('sulla-files:publish', (_event, input:{ fileId:string; versionId:string; expectedDraftVersionId?:string|null; comment?:string }) => json(`/v1/files/${ encodeURIComponent(input.fileId) }/publish`, { method: 'POST', body: JSON.stringify({ versionId: input.versionId, expectedDraftVersionId: input.expectedDraftVersionId, comment: input.comment }) }));
    ipc.handle('sulla-files:retention', (_event, input:{ fileId:string; policy:Record<string, unknown> }) => json(`/v1/files/${ encodeURIComponent(input.fileId) }/retention`, { method: 'PATCH', body: JSON.stringify(input.policy) }));
    ipc.handle('sulla-files:record-lock', (_event, input:{ fileId:string; status:'ordinary'|'policy' }) => json(`/v1/files/${ encodeURIComponent(input.fileId) }/record-lock`, { method: 'POST', body: JSON.stringify({ kind: input.status }) }));
    ipc.handle('sulla-files:record-unlock', (_event, input:{ fileId:string }) => json(`/v1/files/${ encodeURIComponent(input.fileId) }/record-lock`, { method: 'DELETE' }));
    ipc.handle('sulla-files:disposal-review', (_event, input:{ fileId:string; decision:'approve'|'reject'|'extend'; extendedUntil?:string }) => json(`/v1/files/${ encodeURIComponent(input.fileId) }/disposal-review`, { method: 'POST', body: JSON.stringify({ decision: input.decision, extendedUntil: input.extendedUntil }) }));
    ipc.handle('sulla-files:keep', (_event, input:{ fileId:string; collectionId:string; path?:string }) => json(`/v1/agent-files/${ encodeURIComponent(input.fileId) }/keep`, { method: 'POST', body: JSON.stringify({ collectionId: input.collectionId, path: input.path }) }));
    ipc.handle('sulla-files:keep-conflict-copies', (_event, input:{ fileId:string; currentVersionId:string; sourceFileId:string; sourceVersionId:string }) => json(`/v1/files/${ encodeURIComponent(input.fileId) }/conflicts/keep-both`, { method: 'POST', body: JSON.stringify(input) }));
    ipc.handle('files-ui:residency-status', (_event, input:{ fileId: string }) => json(`/v1/files/${ encodeURIComponent(input.fileId) }/residency`));
    ipc.handle('files-ui:set-residency', (_event, input:{ fileId: string; desiredState: 'local' | 'online-only' }) => json(`/v1/files/${ encodeURIComponent(input.fileId) }/residency`, { method: 'POST', body: JSON.stringify({ desiredState: input.desiredState }), signal: AbortSignal.timeout(RESIDENCY_TRANSFER_TIMEOUT_MS) }));
  }
}

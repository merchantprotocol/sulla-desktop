// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { randomUUID } from 'node:crypto';

import { ipcMain } from 'electron';

import { FilesTool } from './common';

import { getWindow } from '@pkg/window';

import type { ToolResponse } from '../base';

interface FilesRecord { file: { id:string; collection_id:string; path:string } }
interface OpenResult { opened:boolean; tabId:string; path:string; how:string }

export function normalizeOpenPath(value:string):string {
  const trimmed = value.trim().replaceAll('\\', '/');
  if (!trimmed) throw new Error('path cannot be empty');
  const relative = trimmed.startsWith('/mnt/sulla-files/') ? trimmed.slice('/mnt/sulla-files/'.length) : trimmed.replace(/^\/+/, '');
  if (!relative || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('path must identify a file or folder inside Sulla Files');
  return `/mnt/sulla-files/${ relative }`;
}

export class FilesOpenWorker extends FilesTool {
  name = '';
  description = '';

  protected async _validatedCall(input:any):Promise<ToolResponse> {
    if (!input.path && !input.file_id) throw new Error('path or file_id is required');
    let fileId = typeof input.file_id === 'string' ? input.file_id.trim() : '';
    let collectionId = '';
    let resolvedPath = '';
    let kind:'file' | 'folder' = 'file';

    if (input.path) {
      const resolved = await this.resolvePath({ ...input, path: normalizeOpenPath(String(input.path)) });
      if (!resolved) throw new Error('That Sulla Files path was not found');
      kind = resolved.kind;
      collectionId = resolved.collectionId;
      fileId = resolved.fileId ?? '';
      resolvedPath = resolved.folderPath ?? normalizeOpenPath(String(input.path)).slice('/mnt/sulla-files/'.length);
    } else {
      const record = await this.containerJson<FilesRecord>(`/v1/agent-files/${ encodeURIComponent(fileId) }`, input);
      fileId = record.file.id;
      collectionId = record.file.collection_id;
      resolvedPath = record.file.path;
    }

    const agentWindow = getWindow('main-agent');
    if (!agentWindow) throw new Error('Main Sulla Desktop window is not available yet');
    const requestId = randomUUID();
    const replyChannel = `agent-command-result:${ requestId }`;
    const result = await new Promise<OpenResult>((resolve, reject) => {
      const timer = setTimeout(() => { ipcMain.removeAllListeners(replyChannel); reject(new Error('Sulla Desktop did not acknowledge the file open request')); }, 10_000);
      ipcMain.once(replyChannel, (event, reply:OpenResult & { error?:string }) => {
        clearTimeout(timer);
        if (event.sender !== agentWindow.webContents) return reject(new Error('Rejected an untrusted file open acknowledgement'));
        if (reply?.error) return reject(new Error(reply.error));
        resolve(reply);
      });
      const dispatch = () => agentWindow.webContents.send('agent-command', { command: 'open-files-item', requestId, fileId, path: resolvedPath, collectionId, kind, mode: input.mode ?? 'edit', focus: input.focus !== false });
      if (agentWindow.webContents.isLoading()) agentWindow.webContents.once('did-finish-load', dispatch); else dispatch();
    });
    if (input.focus !== false) agentWindow.focus();
    return { successBoolean: true, responseString: JSON.stringify(result) };
  }
}

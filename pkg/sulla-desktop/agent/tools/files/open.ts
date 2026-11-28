// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { randomUUID } from 'node:crypto';

import { ipcMain } from 'electron';

import { FilesTool } from './common';
import { AgentFileOpenRoutePolicy } from './AgentFileOpenRoutePolicy';
import { FilesOpenCallBudget } from './FilesOpenCallBudget';
import { InlineFileReferenceMessageFactory } from './InlineFileReferenceMessage';
import { recentFileOpenRegistry } from './RecentFileOpenRegistry';

import type { RecentFileOpenCoordinator } from './RecentFileOpenRegistry';

import { getActiveAgentWindow } from '@pkg/window/agentWindows';
import { agentWindowFromSender } from '@pkg/window/agentWindowTrust';

import type { ToolResponse } from '../base';
import type { FileOpenRouteDecision } from './AgentFileOpenRoutePolicy';

interface FilesRecord { file: { id:string; collection_id:string; path:string } }
interface OpenResult { opened:boolean; tabId:string; path:string; how:string }
const OPEN_CALL_SIGNAL = Symbol('files-open-call-signal');
type OpenCallInput = Record<string, any> & { [OPEN_CALL_SIGNAL]?:AbortSignal };

const SULLA_FILES_ROOT = '/mnt/sulla-files/';
const INLINE_FOLDER_ERROR = 'Inline cards are for files; that path is a folder. Open it with placement "tab" or use files/list.';

class FilesOpenPathNormalizer {
  normalize(value:string):string {
    const trimmed = value.trim().replaceAll('\\', '/');
    if (!trimmed) return SULLA_FILES_ROOT;
    const isSullaFilesRoot = trimmed === SULLA_FILES_ROOT.slice(0, -1) || trimmed === SULLA_FILES_ROOT;
    const isSullaFilesAbsolute = isSullaFilesRoot || trimmed.startsWith(SULLA_FILES_ROOT);
    if (isSullaFilesRoot) return SULLA_FILES_ROOT;
    if ((trimmed.startsWith('/') && !isSullaFilesAbsolute) || /^[a-zA-Z]:\//.test(trimmed) || /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)) {
      throw new Error('path must be relative to Sulla Files or begin with /mnt/sulla-files/; absolute paths outside Sulla Files are not allowed');
    }
    const relative = isSullaFilesAbsolute ? trimmed.slice(SULLA_FILES_ROOT.length) : trimmed;
    if (!relative || relative.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error('path must identify a file or folder inside Sulla Files');
    }
    return `${ SULLA_FILES_ROOT }${ relative }`;
  }
}

export class FilesOpenWorker extends FilesTool {
  name = '';
  description = '';

  constructor(
    private readonly routePolicy = new AgentFileOpenRoutePolicy(),
    private readonly inlineReferenceFactory = new InlineFileReferenceMessageFactory(),
    private readonly pathNormalizer = new FilesOpenPathNormalizer(),
    private readonly recentOpenRegistry:RecentFileOpenCoordinator = recentFileOpenRegistry,
    private readonly openBudgetFactory:() => FilesOpenCallBudget = () => new FilesOpenCallBudget(),
  ) {
    super();
  }

  protected async _validatedCall(input:any):Promise<ToolResponse> {
    const budget = this.openBudgetFactory();
    try {
      return await this.runValidatedCall(input, budget);
    } finally {
      budget.dispose();
    }
  }

  protected override containerRequest(path:string, input:unknown, init:RequestInit = {}):Promise<Response> {
    const signal = input && typeof input === 'object' ? (input as OpenCallInput)[OPEN_CALL_SIGNAL] : undefined;
    return super.containerRequest(path, input, { ...init, ...(signal ? { signal } : {}) });
  }

  private async runValidatedCall(input:any, budget:FilesOpenCallBudget):Promise<ToolResponse> {
    const hasPath = input.path !== undefined && input.path !== null;
    let fileId = typeof input.file_id === 'string' ? input.file_id.trim() : '';
    if (!hasPath && !fileId) throw new Error('path or file_id is required');
    const budgetedInput:OpenCallInput = { ...input, [OPEN_CALL_SIGNAL]: budget.signal };
    let collectionId = '';
    let resolvedPath = '';
    let fileKind:'file' | 'folder' = 'file';

    if (hasPath) {
      const absolutePath = this.pathNormalizer.normalize(String(input.path));
      if (absolutePath === SULLA_FILES_ROOT) {
        if (input.placement === 'inline') throw new Error(INLINE_FOLDER_ERROR);
        throw new Error('That Sulla Files path is a folder. Use files/list to view its contents.');
      }
      let resolved;
      try {
        resolved = await budget.run('resolving the requested file path', () => this.resolvePath({ ...budgetedInput, path: absolutePath }));
      } catch (error) {
        if (this.isNotFound(error)) throw new Error('That Sulla Files path was not found', { cause: error });
        throw error;
      }
      if (!resolved) throw new Error('That Sulla Files path was not found');
      collectionId = resolved.collectionId;
      const isFolder = resolved.kind === 'folder';
      if (isFolder && input.placement === 'inline') throw new Error(INLINE_FOLDER_ERROR);
      fileId = resolved.fileId ?? '';
      const requested = absolutePath.slice(SULLA_FILES_ROOT.length);
      if (isFolder) {
        resolvedPath = resolved.folderPath ?? requested;
        fileKind = 'folder';
      } else {
        // FileResolveRoutes returns folderPath as the file's parent directory
        // (collection-relative). Append the file name so the editor gets the
        // document itself, still collection-relative like the id path.
        const fileName = requested.slice(requested.lastIndexOf('/') + 1);
        resolvedPath = resolved.folderPath === undefined ? requested : (resolved.folderPath ? `${ resolved.folderPath }/${ fileName }` : fileName);
      }
    } else {
      let record:FilesRecord;
      try {
        record = await budget.run('fetching the requested file metadata', () => this.containerJson<FilesRecord>(`/v1/agent-files/${ encodeURIComponent(fileId) }`, budgetedInput));
      } catch (error) {
        if (this.isNotFound(error)) throw new Error('That Sulla Files file_id was not found', { cause: error });
        throw error;
      }
      if (!record?.file || typeof record.file.id !== 'string' || typeof record.file.collection_id !== 'string' || typeof record.file.path !== 'string') {
        throw new Error('That Sulla Files file_id was not found');
      }
      fileId = record.file.id;
      collectionId = record.file.collection_id;
      resolvedPath = record.file.path;
    }

    const metadata = this.state?.metadata as Record<string, any> | undefined;
    const context = {
      threadId:             metadata?.threadId,
      executionThreadId:    this.executionContext?.thread_id,
      hasChatTransport:     typeof this.sendChatMessage === 'function',
      isDesktopChatVisible: metadata?.desktopChatVisible === true,
      isSubAgent:           metadata?.isSubAgent === true,
      isRelayed:            metadata?.relayed === true,
      isChatMuted:          !!metadata?._muteWsChat,
      isSubconsciousSilent: !!metadata?.subconsciousSilent,
    };
    let decision = this.routePolicy.route(input.placement, context);
    if (fileKind === 'folder' && input.placement !== 'tab' && decision.kind === 'inline') {
      decision = this.routePolicy.route('tab', context);
    }
    console.log(`[files/open] route thread=${ metadata?.threadId || '(none)' } placement=${ input.placement ?? 'default' } eligible=${ decision.kind === 'inline' ? 'yes' : 'no' } decision=${ decision.kind } reason=${ decision.kind === 'inline' ? 'visible-desktop-chat' : decision.reason }`);
    if (decision.kind === 'reject') throw new Error(decision.message);
    const threadId = typeof metadata?.threadId === 'string' ? metadata.threadId.trim() : '';
    const key = threadId ? JSON.stringify([threadId, fileId || resolvedPath, decision.kind, input.mode ?? 'edit']) : '';
    return budget.run('waiting for the file open result', () => this.recentOpenRegistry.openOnce(key, () => this.present(input, fileId, collectionId, resolvedPath, fileKind, decision, budget)));
  }

  private async present(input:any, fileId:string, collectionId:string, resolvedPath:string, fileKind:'file' | 'folder', decision:Exclude<FileOpenRouteDecision, { kind:'reject' }>, budget:FilesOpenCallBudget):Promise<ToolResponse> {
    if (decision.kind === 'inline') {
      const record = this.inlineReferenceFactory.create({
        threadId: decision.threadId,
        toolCallId: randomUUID(),
        fileId,
        collectionId,
      });
      await budget.run('delivering the inline file card', () => this.emitInlineFileReference(record));
      const name = resolvedPath.slice(resolvedPath.lastIndexOf('/') + 1);
      return { successBoolean: true, responseString: JSON.stringify({ opened: true, placement: 'inline', fileId, path: resolvedPath, name }) };
    }

    const agentWindow = getActiveAgentWindow();
    if (!agentWindow) {
      if (decision.reason === 'requested-tab' && input.placement === 'tab') throw new Error('Main Sulla Desktop window is not available yet');
      const reason = decision.reason === 'sub-agent'
        ? 'Inline cards only show in a visible Desktop chat; this agent is hidden and no Files tab is available.'
        : fileKind === 'folder'
          ? 'That path is a folder and must open in the Files tab, but no Files tab is available for this call.'
        : 'Inline cards only show in a visible Desktop chat; no Files tab is available for this call.';
      return { successBoolean: true, responseString: JSON.stringify({ opened: false, reason }) };
    }
    const result = await budget.run('waiting for the Desktop to acknowledge the Files tab', () => this.requestOpenResult(agentWindow, input, fileId, collectionId, resolvedPath, fileKind, budget));
    if (input.focus !== false) agentWindow.focus();
    const reason = decision.reason === 'requested-tab'
      ? (fileKind === 'folder' && input.placement !== 'tab' ? 'That folder was opened in the Files tab; inline cards are for files.' : undefined)
      : decision.reason === 'sub-agent'
        ? 'Inline cards only appear in a visible Desktop chat; this hidden sub-agent call was opened in the Files tab instead.'
        : 'Inline cards only appear in a visible Desktop chat; this call was opened in the Files tab instead.';
    return { successBoolean: true, responseString: JSON.stringify({ ...result, ...(reason ? { reason } : {}) }) };
  }

  private requestOpenResult(
    agentWindow:Electron.BrowserWindow,
    input:any,
    fileId:string,
    collectionId:string,
    resolvedPath:string,
    fileKind:'file' | 'folder',
    budget:FilesOpenCallBudget,
  ):Promise<OpenResult> {
    const requestId = randomUUID();
    const replyChannel = `agent-command-result:${ requestId }`;

    return new Promise((resolve, reject) => {
      let settled = false;
      let loadListener:(() => void) | undefined;
      const cleanup = () => {
        ipcMain.removeListener(replyChannel, onReply);
        budget.signal.removeEventListener('abort', onAbort);
        if (loadListener) agentWindow.webContents.removeListener('did-finish-load', loadListener);
        loadListener = undefined;
      };
      const finish = (result?:OpenResult, error?:Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(result!);
      };
      const onReply = (event:Electron.IpcMainEvent, reply:OpenResult & { error?:string }) => {
        // Non-editor files reply from the File Manager tab, which renders in an
        // internal tab-host view owned by the window; resolve it to its owner.
        if (event.sender !== agentWindow.webContents && agentWindowFromSender(event.sender) !== agentWindow) {
          finish(undefined, new Error('Rejected an untrusted file open acknowledgement'));
          return;
        }
        if (reply?.error) {
          finish(undefined, new Error(reply.error));
          return;
        }
        if (reply?.opened !== true) {
          finish(undefined, new Error('Sulla Desktop did not select the requested Files item'));
          return;
        }
        finish(reply);
      };
      const onAbort = () => finish(undefined, new Error('Sulla Files open was aborted before the Desktop Files tab opened'));
      const dispatch = () => {
        if (settled || budget.signal.aborted) return;
        loadListener = undefined;
        try {
          agentWindow.webContents.send('agent-command', { command: 'open-files-item', requestId, fileId, path: resolvedPath, collectionId, kind: fileKind, mode: input.mode ?? 'edit', focus: input.focus !== false });
        } catch (error) {
          finish(undefined, error instanceof Error ? error : new Error(String(error)));
        }
      };

      ipcMain.once(replyChannel, onReply);
      budget.signal.addEventListener('abort', onAbort, { once: true });
      if (budget.signal.aborted) {
        onAbort();
      } else if (agentWindow.webContents.isLoading()) {
        loadListener = dispatch;
        agentWindow.webContents.once('did-finish-load', loadListener);
      } else {
        // Install the unique reply listener before dispatch so synchronous or
        // same-tick renderer acknowledgements cannot beat the subscription.
        dispatch();
      }
    });
  }

  private isNotFound(error:unknown):boolean {
    return error instanceof Error && /not found/i.test(error.message);
  }
}

// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { hostname } from 'node:os';

import { filesContainerRequest } from '../../files/containerClient';
import { BaseTool } from '../base';

import type { ToolResult } from '../../types';
import type { FilesCallerContext } from '../../files/containerClient';


export interface ResolvedFilePath {
  collectionId: string;
  fileId?: string;
  folderPath?: string;
  kind: 'file' | 'folder';
}

export interface UseCaseDraftFile {
  fileId: string;
  versionId: string;
  path: string;
}

/** Write a use-case definition into the home collection.
 * Files creates these versions as drafts; only files_request_publish can make
 * one active, published version.
 */
export async function writeUseCaseDraft(
  tool: FilesTool,
  input: unknown,
  type: 'agents' | 'skills' | 'workflows' | 'functions' | 'recipes',
  slug: string,
  files: Record<string, string>,
): Promise<UseCaseDraftFile[]> {
  const { collectionId } = await tool.agentFilesJson<{ collectionId: string }>('/v1/agent-files/use-case-collection', input);
  const collection = { id: collectionId };
  const result: UseCaseDraftFile[] = [];
  for (const [name, content] of Object.entries(files)) {
    const path = `Use Cases/${ type }/${ slug }/${ name }`;
    const written = await tool.agentFilesJson<{ fileId: string; versionId: string; path: string }>('/v1/agent-files', input, {
      method: 'POST',
      body: JSON.stringify({ collectionId: collection.id, path, content, mime: name.endsWith('.json') ? 'application/json' : name.endsWith('.yaml') || name.endsWith('.yml') ? 'text/yaml' : 'text/markdown', message: `Draft ${ type.slice(0, -1) } ${ slug }` }),
    });
    result.push(written);
  }
  return result;
}

export abstract class FilesTool extends BaseTool {
  override async call(rawInput: unknown): Promise<ToolResult> {
    try {
      return await super.call(rawInput);
    } catch (error) {
      // BaseTool validates the manifest before its handler catch block. Keep
      // malformed Files arguments as ordinary tool errors instead of allowing
      // the outer Desktop dispatcher to turn them into desktop_tool_failed.
      return { toolName: this.name, success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  protected context(_input?: unknown): FilesCallerContext {
    if (this.executionContext) return this.executionContext;
    const metadata = (this.state)?.metadata ?? {};
    const userId = metadata.userId ?? metadata.ownerUserId;

    return {
      sub:        userId ? String(userId) : undefined,
      org_id:     metadata.orgId,
      agent_id:   metadata.agentId,
      job_id:     metadata.jobId,
      thread_id:  metadata.threadId,
      device_id:  metadata.deviceId ?? hostname(),
    };
  }

  protected async containerRequest(path: string, input: unknown, init: RequestInit = {}): Promise<Response> {
    const context = this.context(input);
    try {
      return await filesContainerRequest(path, context, init);
    } catch (error) {
      throw this.clearTransportError(error);
    }
  }

  private clearTransportError(error: unknown): Error {
    const details = error instanceof Error ? error : undefined;
    const value = typeof error === 'object' && error !== null ? error as { name?:unknown; message?:unknown } : undefined;
    const name = details?.name ?? (typeof value?.name === 'string' ? value.name : undefined);
    const message = details?.message ?? (typeof value?.message === 'string' ? value.message : String(error));
    // Preserve the transport's own actionable errors, including the recovery
    // message introduced by the Files transport owner. Older Electron builds
    // only expose the browser-generated AbortError/TimeoutError instead.
    if (/^Sulla Files\b/i.test(message)) return details ?? new Error(message);
    if (name === 'AbortError' || name === 'TimeoutError') {
      return new Error('Sulla Files is unreachable right now. Please try again in a moment.', { cause: error });
    }
    return details ?? new Error(message);
  }

  protected async resolvePath(input: any): Promise<ResolvedFilePath | undefined> {
    if (!input?.path) return undefined;
    const supplied = String(input.path).trim().replaceAll('\\', '/');
    const relative = supplied.startsWith('/mnt/sulla-files/') ? supplied.slice('/mnt/sulla-files/'.length) : supplied.replace(/^\/+/, '');
    if (!relative || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('path must identify a file or folder inside Sulla Files');
    const absolute = `/mnt/sulla-files/${ relative }`;
    return this.containerJson<ResolvedFilePath>(`/v1/files/resolve?path=${ encodeURIComponent(absolute) }`, input);
  }

  protected async containerJson<T = any>(path: string, input: unknown, init: RequestInit = {}): Promise<T> {
    const response = await this.containerRequest(path, input, init);

    return response.status === 204 ? undefined as T : await response.json() as T;
  }

  async agentFilesJson<T = any>(path: string, input: unknown, init: RequestInit = {}): Promise<T> {
    return this.containerJson<T>(path, input, init);
  }
}

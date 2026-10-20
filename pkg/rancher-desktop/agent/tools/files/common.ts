import { hostname } from 'node:os';

import { filesContainerRequest } from '../../files/containerClient';
import { BaseTool } from '../base';

import type { FilesCallerContext } from '../../files/containerClient';

export interface UseCaseDraftFile {
  fileId: string;
  versionId: string;
  path: string;
}

/** Write a use-case definition into the agent scratch Files collection.
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
  const collection = await tool.agentFilesJson<{ collectionId: string }>('/v1/agent-files/ensure', input, { method: 'POST', body: '{}' });
  const result: UseCaseDraftFile[] = [];
  for (const [name, content] of Object.entries(files)) {
    const path = `Sulla/Use Cases/${ type }/${ slug }/${ name }`;
    const written = await tool.agentFilesJson<{ fileId: string; versionId: string; path: string }>('/v1/agent-files', input, {
      method: 'POST',
      body: JSON.stringify({ collectionId: collection.collectionId, path, content, mime: name.endsWith('.json') ? 'application/json' : name.endsWith('.yaml') || name.endsWith('.yml') ? 'text/yaml' : 'text/markdown', message: `Draft ${ type.slice(0, -1) } ${ slug }` }),
    });
    result.push(written);
  }
  return result;
}

export abstract class FilesTool extends BaseTool {
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
    return filesContainerRequest(path, context, init);
  }

  protected async containerJson<T = any>(path: string, input: unknown, init: RequestInit = {}): Promise<T> {
    const response = await this.containerRequest(path, input, init);

    return response.status === 204 ? undefined as T : await response.json() as T;
  }

  async agentFilesJson<T = any>(path: string, input: unknown, init: RequestInit = {}): Promise<T> {
    return this.containerJson<T>(path, input, init);
  }
}

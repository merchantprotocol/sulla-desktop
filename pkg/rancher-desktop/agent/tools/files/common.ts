import { hostname } from 'node:os';

import { filesContainerRequest } from '../../files/containerClient';
import { BaseTool } from '../base';

import type { ToolExecutionContext } from '../executionContext';

export abstract class FilesTool extends BaseTool {
  protected context(_input?: unknown): ToolExecutionContext {
    if (this.executionContext) return this.executionContext;
    const metadata = (this.state)?.metadata ?? {};
    const userId = metadata.userId ?? metadata.ownerUserId ?? 'desktop-cli';
    const now = Math.floor(Date.now() / 1_000);

    return {
      v:          1,
      iss:        'sulla-desktop',
      aud:        'sulla-tools',
      sub:        String(userId),
      org_id:     metadata.orgId,
      agent_id:   metadata.agentId,
      job_id:     metadata.jobId,
      thread_id:  metadata.threadId,
      device_id:  metadata.deviceId ?? hostname(),
      scopes:     ['files/*'],
      iat:        now,
      exp:        now + 3_600,
      jti:        metadata.requestId ?? `desktop-${ Date.now() }`,
      request_id: metadata.requestId ?? `desktop-${ Date.now() }`,
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
}

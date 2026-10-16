import { hostname } from 'node:os';

import { SullaSettingsModel } from '../../database/models/SullaSettingsModel';
import { getSullaFilesService } from '../../files/runtime';
import { BaseTool } from '../base';

import { issueCapabilityToken } from '@pkg/runtime/capabilityToken';

import type { ToolExecutionContext } from '../executionContext';

export const filesService = getSullaFilesService;
const FILES_API = process.env.SULLA_FILES_API_URL?.replace(/\/+$/, '') || 'http://127.0.0.1:30124';

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
    const secret = await SullaSettingsModel.getServicePassword();
    const signingKey = process.env.SULLA_FILES_CAPABILITY_SIGNING_KEY || process.env.SULLA_FILES_INTERNAL_TOKEN || secret;
    const token = issueCapabilityToken({ sub: context.sub, device_id: context.device_id, scopes: ['files/*'], expiresInSeconds: 300 }, signingKey);
    const headers = new Headers(init.headers); headers.set('Authorization', `Bearer ${ token }`);
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const response = await fetch(`${ FILES_API }${ path }`, { ...init, headers });
    if (!response.ok) throw new Error(`Sulla Files returned ${ response.status }: ${ (await response.text()).slice(0, 200) }`);
    return response;
  }
}

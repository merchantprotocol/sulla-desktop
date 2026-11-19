// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { IpcController, IpcRegistrar } from './ipc/IpcController';

/** Sends one authenticated request to Sulla Cloud. */
export type CloudRequester = (method: string, path: string, init: { headers: Record<string, string>; body?: string }) => Promise<Response>;
export type SupportSessionLogger = (message: string, details: { channel: string; code?: string; status?: number }) => void;

/** Super-admin support-session API on Sulla Cloud. */
export class SupportSessionCloudClient {
  constructor(private readonly cloudRequest: CloudRequester) {}

  pathFor(id: string, suffix = ''): string {
    return `/super-admin/support/sessions/${ encodeURIComponent(id) }${ suffix }`;
  }

  async request(method: string, path: string, body?: unknown): Promise<any> {
    const response = await this.cloudRequest(method, path, { headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const payload = await response.json().catch(() => ({})) as any;
    if (!response.ok) {
      const error: any = new Error(payload.message || payload.error || `Sulla Cloud returned ${ response.status }`);
      error.code = payload.error;
      error.status = response.status;
      throw error;
    }

    return payload;
  }
}

/** support-session:* — the support console's session view. */
export class SupportSessionIpcController implements IpcController {
  constructor(private readonly ipc: IpcRegistrar, private readonly cloud: SupportSessionCloudClient, private readonly log: SupportSessionLogger = (message, details) => console.error(message, details)) {}

  register(): void {
    const cloud = this.cloud;
    const handle = (channel: string, action: (...args: any[]) => Promise<any>) => this.ipc.handle(channel, async(_e: unknown, ...args: any[]) => {
      try { return await action(...args); }
      catch (error: any) {
        this.log('[support-session] request failed', { channel, ...(typeof error?.code === 'string' ? { code: error.code } : {}), ...(typeof error?.status === 'number' ? { status: error.status } : {}) });
        throw error;
      }
    });
    handle('support-session:get', async(id: string) => {
      const payload = await cloud.request('GET', '/super-admin/support/sessions?limit=100');
      const session = Array.isArray(payload.sessions) ? payload.sessions.find((item: any) => item?.id === id) : undefined;
      if (!session) {
        const error: any = new Error('Support session not found or not authorized.');
        error.code = 'session_not_found';
        error.status = 404;
        throw error;
      }

      return { session };
    });
    handle('support-session:events', (id: string) => cloud.request('GET', cloud.pathFor(id, '/events?limit=100')));
    handle('support-session:end', (id: string, reason = 'resolved') => cloud.request('POST', cloud.pathFor(id, '/end'), { reason }));
    handle('support-session:extend', (id: string, hours: number) => cloud.request('POST', cloud.pathFor(id, '/extend'), { hours }));
    handle('support-session:presence', (id: string) => cloud.request('GET', cloud.pathFor(id, '/presence')));
  }
}

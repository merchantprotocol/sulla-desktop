// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { getDesktopDeviceId } from '../../deviceIdentity';
import { getCurrentUserId } from '../../sullaCloudAuth';
import { cloudRequest } from '../cloudFetch';
import { signDeviceMessage } from '../deviceKey';
import { createHash } from 'crypto';

export interface SlackInboundFrame { id: string; eventId: string; apiAppId: string; teamId: string; receivedAt: string; event: Record<string, unknown> }

export class SlackCloudClient {
  async register(apiAppId: string, teamSlackId: string): Promise<void> {
    await this.workspaceRequest('POST', apiAppId, teamSlackId, 'register');
  }

  async unregister(apiAppId: string, teamSlackId: string): Promise<void> {
    await this.workspaceRequest('DELETE', apiAppId, teamSlackId, 'unregister');
  }

  private async workspaceRequest(method: 'POST' | 'DELETE', apiAppId: string, teamSlackId: string, op: 'register' | 'unregister'): Promise<void> {
    const deviceId = await getDesktopDeviceId();
    const userId = await getCurrentUserId();
    const body = JSON.stringify({ apiAppId, teamSlackId });
    const proof = signDeviceMessage('slack-workspace-v1', [userId, deviceId, op, this.hash(body)]);
    const response = await cloudRequest(method, `/slack/workspaces?deviceId=${encodeURIComponent(deviceId)}`, {
      headers: {
        'Content-Type': 'application/json',
        'X-Sulla-Timestamp': String(proof.ts),
        'X-Sulla-Device-Signature': proof.signature,
      },
      body,
    });
    if(!response.ok) {
      const result = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(result.error === 'workspace_claimed' ? 'workspace_claimed' : `Slack workspace registration failed (${response.status})`);
    }
  }

  async pending(): Promise<SlackInboundFrame[]> {
    const response = await this.request<{ events: SlackInboundFrame[] }>('GET', '/slack/inbound', 'pull');
    return response.events;
  }

  async drain(): Promise<SlackInboundFrame[]> {
    return this.pending();
  }

  async ack(ids: string[]): Promise<void> {
    for (let index = 0; index < ids.length; index += 50) {
      const body = JSON.stringify({ ids: ids.slice(index, index + 50) });
      await this.request('POST', '/slack/inbound/ack', 'ack', body);
    }
  }

  private async request<T>(method: 'GET' | 'POST', path: string, op: 'pull' | 'ack', body?: string): Promise<T> {
    const deviceId = await getDesktopDeviceId();
    const userId = await getCurrentUserId();
    const proof = signDeviceMessage('slack-inbound-v1', [userId, deviceId, op, this.hash(body ?? '')]);
    const response = await cloudRequest(method, `${path}?deviceId=${encodeURIComponent(deviceId)}`, {
      headers: {
        'Content-Type': 'application/json',
        'X-Sulla-Timestamp': String(proof.ts),
        'X-Sulla-Device-Signature': proof.signature,
      },
      ...(body ? { body } : {}),
    });
    if (!response.ok) throw new Error(`Slack inbound request failed (${response.status})`);
    return await response.json() as T;
  }

  private hash(body: string): string {
    return createHash('sha256').update(body, 'utf8').digest('hex');
  }
}

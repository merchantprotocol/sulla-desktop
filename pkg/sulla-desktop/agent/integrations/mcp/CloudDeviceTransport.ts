// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import crypto from 'crypto';

import { cloudRequest } from '@pkg/main/cloud/cloudFetch';
import { signDeviceMessageExact } from '@pkg/main/cloud/deviceKey';
import { getDesktopDeviceId } from '@pkg/main/deviceIdentity';
import { getCurrentUserId } from '@pkg/main/sullaCloudAuth';

import type { MCPToolCallResult, MCPToolDefinition } from './MCPClient';
import type { ToolExecutionContext } from '../../tools/executionContext';

export interface CloudAppDevice {
  id:         string;
  deviceType: string;
  appSlug?:   string | null;
  name:       string;
  online:     boolean;
}

export interface CloudToolManifest {
  appSlug: string;
  tools:   Array<{
    name:         string;
    description?: string;
    inputSchema?: MCPToolDefinition['inputSchema'];
  }>;
}

interface RpcEnvelope {
  v:                1;
  targetDeviceId:   string;
  callerDeviceId:   string;
  ts:               number;
  nonce:            string;
  callId:           string;
  body: {
    jsonrpc: '2.0';
    id:      string;
    method:  'initialize' | 'ping' | 'tools/list' | 'tools/call';
    params?: unknown;
  };
}

export interface CloudDeviceChannel {
  listDevices(): Promise<CloudAppDevice[]>;
  getManifest(deviceId: string): Promise<CloudToolManifest>;
  rpc(deviceId: string, envelope: RpcEnvelope, signature: string): Promise<any>;
  identity(): Promise<{ userId: string; deviceId: string }>;
  sign(parts: (string | number)[], ts: number): { ts: number; signature: string };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${ value.map(canonicalJson).join(',') }]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${ Object.keys(object).sort()
      .map(key => `${ JSON.stringify(key) }:${ canonicalJson(object[key]) }`).join(',') }}`;
  }
  return JSON.stringify(value) ?? 'null';
}

async function jsonRequest<T>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
  const response = await cloudRequest(method, path, {
    headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({})) as any;
  if (!response.ok) {
    const code = result?.error || result?.code || `HTTP ${ response.status }`;
    if (response.status === 503 && code === 'device_offline') {
      throw new Error('This Cloud app device is offline. Start it and try again.');
    }
    throw new Error(`Sulla Cloud device request failed: ${ code }`);
  }
  return result as T;
}

export const defaultCloudDeviceChannel: CloudDeviceChannel = {
  async listDevices() {
    const result = await jsonRequest<{ devices?: CloudAppDevice[] }>('GET', '/devices');
    return (result.devices || []).filter(device => device.deviceType === 'app' && !!device.appSlug);
  },
  async getManifest(deviceId) {
    const result = await jsonRequest<{ manifest: CloudToolManifest | null }>(
      'GET', `/device-tools/${ encodeURIComponent(deviceId) }/manifest`,
    );
    if (!result.manifest) throw new Error('Cloud app device has not published a tool manifest.');
    return result.manifest;
  },
  rpc(deviceId, envelope, signature) {
    return jsonRequest('POST', `/device-tools/${ encodeURIComponent(deviceId) }/rpc`, envelope, {
      'X-Sulla-Device-Signature': signature,
    });
  },
  async identity() {
    const [userId, deviceId] = await Promise.all([getCurrentUserId(), getDesktopDeviceId()]);
    if (!userId) throw new Error('Sign in to Sulla Cloud to use app tools.');
    return { userId, deviceId };
  },
  sign(parts, ts) {
    return { ts, signature: signDeviceMessageExact('device-tools-rpc-v1', parts) };
  },
};

export class CloudDeviceTransport {
  private _tools: MCPToolDefinition[];

  constructor(
    readonly accountId: string,
    readonly targetDeviceId: string,
    manifest: CloudToolManifest,
    private readonly channel: CloudDeviceChannel = defaultCloudDeviceChannel,
  ) {
    this._tools = this.normalizeTools(manifest.tools);
  }

  get url(): string {
    return `sulla-cloud://device/${ this.targetDeviceId }`;
  }

  get tools(): MCPToolDefinition[] {
    return this._tools;
  }

  async initialize(): Promise<void> {
    await this.rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities:    {},
      clientInfo:      { name: 'sulla-desktop', version: '1.0.0' },
    });
    await this.discoverTools();
  }

  async discoverTools(): Promise<MCPToolDefinition[]> {
    const response = await this.rpc('tools/list');
    this._tools = this.normalizeTools(response?.result?.tools || response?.tools || []);
    return this._tools;
  }

  async callTool(
    toolName: string,
    args: Record<string, any> = {},
    _executionContext?: ToolExecutionContext,
  ): Promise<MCPToolCallResult> {
    const response = await this.rpc('tools/call', { name: toolName, arguments: args });
    const result = response?.result ?? response;
    const content = Array.isArray(result?.content) ? result.content : [];
    const isError = !!result?.isError;
    return { success: !isError, content, isError, raw: result };
  }

  async close(): Promise<void> {}

  private normalizeTools(tools: CloudToolManifest['tools']): MCPToolDefinition[] {
    return tools.map(tool => ({
      name:        tool.name,
      description: tool.description || '',
      inputSchema: {
        type:       'object',
        properties: tool.inputSchema?.properties || {},
        required:   tool.inputSchema?.required || [],
      },
    }));
  }

  private async rpc(method: RpcEnvelope['body']['method'], params?: unknown): Promise<any> {
    const { userId, deviceId } = await this.channel.identity();
    const ts = Math.floor(Date.now() / 1000);
    const callId = crypto.randomUUID();
    const envelope: RpcEnvelope = {
      v: 1, targetDeviceId: this.targetDeviceId, callerDeviceId: deviceId,
      ts, nonce: crypto.randomUUID(), callId,
      body: { jsonrpc: '2.0', id: callId, method, ...(params === undefined ? {} : { params }) },
    };
    const digest = crypto.createHash('sha256').update(canonicalJson(envelope)).digest('hex');
    const proof = this.channel.sign([userId, deviceId, this.targetDeviceId, callId, ts, digest], ts);
    if (proof.ts !== ts) {
      throw new Error('Device signing clock changed while preparing the Cloud tool call.');
    }
    return this.channel.rpc(this.targetDeviceId, envelope, proof.signature);
  }
}

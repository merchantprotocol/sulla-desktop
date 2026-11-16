// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { issueCapabilityToken } from './auth.js';

import type { Config } from './config.js';

/** HTTP client for the legacy Files sync server (config.serverUrl), authenticated with a device capability. */
export class RemoteFilesClient {
  constructor(private readonly config:Config, private readonly fetcher:typeof fetch = (input, init) => fetch(input, init)) {}

  headers(extra:Record<string, string> = {}):Record<string, string> { return { authorization: `Bearer ${ issueCapabilityToken({ sub: this.config.userId, device_id: this.config.deviceId, scopes: ['files/*'] }, this.config.capabilitySigningKey) }`, ...extra } }

  async json(path:string, init:RequestInit = {}):Promise<any> {
    const response = await this.fetcher(new URL(path, this.config.serverUrl), { ...init, headers: { ...this.headers({ 'content-type': 'application/json' }), ...(init.headers as any) } });
    if (!response.ok) { const body:any = await response.json().catch(() => ({})); throw Object.assign(new Error(body.error ?? `sync HTTP ${ response.status }`), { status: response.status, body }) }
    return response.status === 204 ? undefined : response.json();
  }

  async putChunk(collectionId:string, id:string, bytes:Uint8Array):Promise<void> {
    const response = await this.fetcher(new URL(`/v1/chunks/${ collectionId }/${ id }`, this.config.serverUrl), { method: 'PUT', headers: this.headers({ 'content-type': 'application/octet-stream' }), body: new Uint8Array(bytes) });
    if (!response.ok) throw new Error(`chunk upload failed ${ response.status }`);
  }

  async getChunk(collectionId:string, id:string):Promise<Uint8Array> {
    const response = await this.fetcher(new URL(`/v1/chunks/${ collectionId }/${ id }`, this.config.serverUrl), { headers: this.headers() });
    if (!response.ok) throw new Error(`chunk download failed ${ response.status }`);
    return new Uint8Array(await response.arrayBuffer());
  }
}

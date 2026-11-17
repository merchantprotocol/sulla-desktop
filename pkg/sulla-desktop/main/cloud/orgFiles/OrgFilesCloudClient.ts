// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { OrgFilesContract, type OrgCollectionKeyWrap, type OrgFilesRoute } from '@sulla/domain';
import { cloudRequest } from '../cloudFetch';

export type OrgFilesCloudTransport = (method: string, path: string, body?: unknown) => Promise<unknown>;

export class OrgFilesCloudError extends Error {
  constructor(readonly status: number) { super(`Org Files Cloud request failed (${status})`); }
}

export class OrgFilesCloudClient {
  constructor(private readonly transport: OrgFilesCloudTransport = OrgFilesCloudClient.authenticatedRequest) {}

  publishRecipientKey(orgId: string, key: unknown): Promise<void> {
    const request = new OrgFilesContract().recipientKeyRequest({ key });
    return this.mutate(OrgFilesContract.routes.publishRecipientKey, { orgId }, request).then(() => undefined);
  }

  async recipientKeys(orgId: string) {
    return new OrgFilesContract().recipientKeysResponse(await this.get(OrgFilesContract.routes.listRecipientKeys, { orgId }));
  }

  async myKeyWraps(orgId: string, keyVersion?: number) {
    const path = this.path(OrgFilesContract.routes.getMyKeyWraps, { orgId }) + (keyVersion ? `?keyVersion=${keyVersion}` : '');
    return new OrgFilesContract().keyWrapsResponse(await this.transport('GET', path));
  }

  putKeyWraps(orgId: string, wraps: unknown): Promise<void> {
    const body = new OrgFilesContract().putKeyWrapsRequest({ wraps });
    return this.mutate(OrgFilesContract.routes.putKeyWraps, { orgId }, body).then(() => undefined);
  }

  async pendingKeyWraps(orgId: string) {
    return new OrgFilesContract().pendingKeyWrapsResponse(await this.get(OrgFilesContract.routes.pendingKeyWraps, { orgId }));
  }

  async collections(orgId: string) {
    return new OrgFilesContract().collectionsResponse(await this.get(OrgFilesContract.routes.listCollections, { orgId }));
  }

  async getCollectionKeyWrap(orgId: string, collectionId: string): Promise<OrgCollectionKeyWrap> {
    const route = OrgFilesContract.routes.listCollections;
    const response = await this.get(route, { orgId });
    // Validate the full endpoint response, but read the optional-in-older-contract
    // key-wrap field from the original response so contract projection cannot strip it.
    new OrgFilesContract().collectionsResponse(response);
    const payload = response as { collections?: Array<{ collection?: { collectionId?: string; collectionKeyWrap?: OrgCollectionKeyWrap } }> };
    const collection = payload.collections?.find(item => item.collection?.collectionId === collectionId)?.collection;
    if (!collection?.collectionKeyWrap) throw new Error(`Org Files collection ${collectionId} did not include its root key wrap`);
    return collection.collectionKeyWrap;
  }

  async createCollection(orgId: string, body: unknown): Promise<void> {
    const request = new OrgFilesContract().createCollectionRequest(body);
    await this.mutate(OrgFilesContract.routes.createCollection, { orgId }, request);
  }

  async grants(orgId: string, collectionId: string) {
    return new OrgFilesContract().grantsResponse(await this.get(OrgFilesContract.routes.listGrants, { orgId, collectionId }));
  }

  async setGrant(orgId: string, collectionId: string, body: unknown): Promise<void> {
    const request = new OrgFilesContract().grantRequest(body);
    await this.mutate(OrgFilesContract.routes.setGrant, { orgId, collectionId }, request);
  }

  private async get(route: OrgFilesRoute, params: Record<string, string>): Promise<unknown> {
    return this.transport(route.method, this.path(route, params));
  }

  private async mutate(route: OrgFilesRoute, params: Record<string, string>, body: unknown): Promise<unknown> {
    return this.transport(route.method, this.path(route, params), body);
  }

  private path(route: OrgFilesRoute, params: Record<string, string>): string {
    return route.path.replace(/:([A-Za-z]+)/g, (_match, key: string) => {
      const value = params[key];
      if (!value) throw new Error(`Missing org Files route parameter: ${key}`);
      return encodeURIComponent(value);
    }).replace(/^/, OrgFilesContract.base);
  }

  private static async authenticatedRequest(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await cloudRequest(method, path, {
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new OrgFilesCloudError(response.status);
    return value;
  }
}

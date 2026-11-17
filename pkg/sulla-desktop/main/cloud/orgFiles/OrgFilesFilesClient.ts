// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { FilesTransportEnvelopeService, type FilesTransportEnvelope } from '@sulla/vault-crypto';
import { getSullaFilesClient, type SullaFilesClient } from '@pkg/main/sullaFilesClient';

export interface OrgRootTransportRequest { requestId: string; recipientPublicKey: string }
export interface OrgFilesEnrollment { id: string; orgId: string; orgName: string; name: string; creatorUserId: string; level: 'view' | 'edit' | 'manage' }
export interface OrgFilesLocalCollection extends OrgFilesEnrollment { id: string }
export interface OrgFilesRootHandoff { requestId: string; keyVersion: number; transport: FilesTransportEnvelope }
export type OrgFilesFilesRequest = (path: string, init?: RequestInit) => Promise<unknown>;

/** Desktop-control client for local Files org collection enrollment and root delivery. */
export class OrgFilesFilesClient {
  constructor(
    private readonly request: OrgFilesFilesRequest = (path, init) => getSullaFilesClient().json(path, init),
    private readonly envelopes: FilesTransportEnvelopeService = new FilesTransportEnvelopeService(),
  ) {}

  async list(): Promise<OrgFilesLocalCollection[]> {
    return await this.request('/v1/desktop/org-collections') as OrgFilesLocalCollection[];
  }

  enroll(collection: OrgFilesEnrollment): Promise<unknown> {
    const { id, ...body } = collection;
    return this.request(`/v1/desktop/org-collections/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) });
  }

  updateLevel(collectionId: string, level: OrgFilesEnrollment['level']): Promise<unknown> {
    return this.request(`/v1/desktop/org-collections/${encodeURIComponent(collectionId)}/level`, { method: 'PATCH', body: JSON.stringify({ level }) });
  }

  async unenroll(collectionId: string): Promise<void> {
    await this.request(`/v1/desktop/org-collections/${encodeURIComponent(collectionId)}`, { method: 'DELETE' });
  }

  async pushRoot(collectionId: string, keyVersion: number, root: Uint8Array): Promise<void> {
    const recipient = await this.request('/v1/desktop/org-collections/root-transport', { method: 'POST' }) as OrgRootTransportRequest;
    const transport = await this.envelopes.wrap(root, recipient.recipientPublicKey, recipient.requestId, collectionId, keyVersion);
    await this.request(`/v1/desktop/org-collections/${encodeURIComponent(collectionId)}/root`, {
      method: 'PUT', body: JSON.stringify({ requestId: recipient.requestId, keyVersion, transport }),
    });
  }

  /** Asks Files to drop one Cloud profile's org roots and collection keys (sign-out or lock). */
  async invalidateProfile(profileId: string): Promise<void> {
    await this.request(`/v1/desktop/org-profiles/${encodeURIComponent(profileId)}/invalidate`, { method: 'POST' });
  }

  async enableSync(collectionId: string, keyVersion: number, head?: string | null): Promise<void> {
    await this.request(`/v1/desktop/org-collections/${encodeURIComponent(collectionId)}/sync`, {
      method: 'POST', body: JSON.stringify({ keyVersion, ...(head === undefined ? {} : { head }) }),
    });
  }

}

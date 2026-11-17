// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { OrgFilesCloudClient } from './OrgFilesCloudClient';
import type { OrgFilesFilesClient, OrgFilesLocalCollection } from './OrgFilesFilesClient';
import type { OrgFilesKeyring } from './OrgFilesKeyring';
import type { OrgMembership, OrgMembershipDirectory } from '../../../agent/services/OrgMembershipDirectory';

export interface OrgCollectionSyncLogger { warn(message: string, error?: unknown): void }

/** Reconciles the signed-in user's Cloud org collections with local Files. */
export class OrgCollectionSyncDriver {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private running: Promise<void> | null = null;

  constructor(
    private readonly memberships: Pick<OrgMembershipDirectory, 'refresh'>,
    private readonly cloud: Pick<OrgFilesCloudClient, 'collections' | 'getCollectionKeyWrap'>,
    private readonly keyring: Pick<OrgFilesKeyring, 'ensureRecipientKey' | 'wrapPendingMembers' | 'unwrapCollectionRoot'>,
    private readonly files: Pick<OrgFilesFilesClient, 'list' | 'enroll' | 'updateLevel' | 'unenroll' | 'pushRoot' | 'enableSync'>,
    private readonly logger: OrgCollectionSyncLogger = console,
    private readonly intervalMs = 60_000,
  ) {}

  start(): void { this.stopped = false; this.schedule(0); }
  wake(): void { if (!this.stopped) this.schedule(0); }
  stop(): void { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.timer = null; }

  async tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.reconcile().finally(() => { this.running = null; });
    return this.running;
  }

  private async reconcile(): Promise<void> {
    let organizations: readonly OrgMembership[];
    try { organizations = await this.memberships.refresh(); }
    catch (error) { this.logger.warn('[OrgCollectionSyncDriver] Could not refresh org memberships', error); return; }
    const local = await this.files.list().catch(error => {
      this.logger.warn('[OrgCollectionSyncDriver] Could not list local org collections', error); return [] as OrgFilesLocalCollection[];
    });
    const localById = new Map(local.map(item => [item.id, item]));
    const found = new Set<string>();
    const completedOrgs = new Set<string>();
    const memberOrgs = new Set(organizations.map(org => org.orgId));
    for (const org of organizations) {
      try {
        await this.keyring.ensureRecipientKey(org.orgId);
        try { await this.keyring.wrapPendingMembers(org.orgId); }
        catch (error) {
          if (this.isNotAllowed(error)) {
            this.logger.warn(`[OrgCollectionSyncDriver] Cloud does not allow pending-member wraps for ${org.orgId}`);
          } else {
            throw error;
          }
        }
        const remote = await this.cloud.collections(org.orgId);
        completedOrgs.add(org.orgId);
        for (const row of remote.collections) await this.syncCollection(org, row, localById, found);
      } catch (error) { this.logger.warn(`[OrgCollectionSyncDriver] Org ${org.orgId} sync failed`, error); }
    }
    for (const entry of local) {
      if (!found.has(entry.id) && (!memberOrgs.has(entry.orgId) || completedOrgs.has(entry.orgId))) {
        try { await this.files.unenroll(entry.id); }
        catch (error) { this.logger.warn(`[OrgCollectionSyncDriver] Could not unenroll collection ${entry.id}`, error); }
      }
    }
  }

  private async syncCollection(
    org: OrgMembership,
    row: Awaited<ReturnType<OrgFilesCloudClient['collections']>>['collections'][number],
    localById: Map<string, OrgFilesLocalCollection>,
    found: Set<string>,
  ): Promise<void> {
    const collection = row.collection;
    try {
      if (row.effectiveLevel === 'none') return;
      found.add(collection.collectionId);
      const current = localById.get(collection.collectionId);
      const body = { id: collection.collectionId, orgId: org.orgId, orgName: org.name,
        name: collection.name, creatorUserId: collection.creatorUserId, level: row.effectiveLevel } as const;
      if (!current) await this.files.enroll(body);
      else if (current.level !== row.effectiveLevel) await this.files.updateLevel(collection.collectionId, row.effectiveLevel);
      const wrap = await this.cloud.getCollectionKeyWrap(org.orgId, collection.collectionId);
      const root = await this.keyring.unwrapCollectionRoot(org.orgId, wrap);
      try {
        await this.files.pushRoot(collection.collectionId, collection.keyVersion, root);
        await this.files.enableSync(collection.collectionId, collection.keyVersion);
      } finally { root.fill(0); }
    } catch (error) { this.logger.warn(`[OrgCollectionSyncDriver] Collection ${collection.collectionId} sync failed`, error); }
  }

  private isNotAllowed(error: unknown): boolean {
    return !!error && typeof error === 'object' && 'status' in error && Number((error as { status: unknown }).status) === 404;
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick().finally(() => this.schedule(this.intervalMs));
    }, delay);
    this.timer.unref?.();
  }
}

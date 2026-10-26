import { timingSafeEqual } from 'node:crypto';

import type { ChangesPage } from './cloudApi.js';
import { openCollectionInfo, openEscrowWithKey, verifyHead, type CollectionInfoEnvelope, type EscrowEnvelope, type TransportEnvelope } from './envelope.js';
import type { EscrowTransportRequests } from './escrowTransport.js';
import { isUuid } from './validation.js';

export interface RestoreInput {
  collectionId:string;
  name:string;
  requestId:string;
  transport:TransportEnvelope;
  vaultId:string;
  vaultEpoch:number;
}

/** Local side of a restore. PgRestoreTarget (service.ts) implements it; tests use an in-memory fake. */
export interface RestoreTarget {
  /** null when no local collection has this id. */
  localRoot(collectionId:string):Promise<{ keyVersion:number; root:Buffer | null } | null>;
  createCollection(collectionId:string, name:string):Promise<void>;
  install(collectionId:string, keyVersion:number, root:Uint8Array, vaultId:string, vaultEpoch:number):Promise<void>;
}

export interface RestoreCloud {
  keys(collectionId:string):Promise<Array<{ keyVersion:number; escrow:unknown }>>;
  changes(collectionId:string, since:number, limit:number):Promise<ChangesPage>;
  /** Cloud's collection list; carries each collection's sealed folder name. */
  listCollections?():Promise<any[]>;
}

/** One collection to restore with an escrow key that is already unwrapped. */
export interface RestoreWithKeyInput {
  collectionId:string;
  /** Used when Cloud has no readable folder name for the collection. */
  name:string;
  vaultId:string;
  vaultEpoch:number;
  info?:unknown;
}

export class RestoreError extends Error {
  constructor(readonly status:number, readonly code:string, message:string) { super(message) }
}

function validEscrow(value:unknown, collectionId:string, vaultId:string, vaultEpoch:number):value is EscrowEnvelope {
  const escrow = value as EscrowEnvelope;
  return Boolean(escrow) && escrow.format === 'sulla-files-sync-escrow' && escrow.collectionId === collectionId &&
    escrow.vaultId === vaultId && escrow.vaultEpoch === vaultEpoch && Number.isInteger(escrow.keyVersion) && escrow.keyVersion >= 1;
}

/**
 * Second-device restore (FILES-SYNC-DESIGN.md §6.1). Everything that can be
 * refused is checked before any local row is written: the transport pair, the
 * escrow for this exact vault, the escrow itself, and the cloud head MAC.
 */
export class CloudRestore {
  constructor(
    private readonly transport:Pick<EscrowTransportRequests, 'unwrap'>,
    private readonly cloud:RestoreCloud,
    private readonly target:RestoreTarget,
  ) {}

  async restore(input:RestoreInput):Promise<{ restored:true; collectionId:string }> {
    if (!isUuid(input?.collectionId) || !isUuid(input.vaultId) || !isUuid(input.requestId)) throw new RestoreError(400, 'invalid_request', 'Restore request is invalid');
    if (!Number.isSafeInteger(input.vaultEpoch) || input.vaultEpoch < 1) throw new RestoreError(400, 'invalid_request', 'Restore request is invalid');
    const name = typeof input.name === 'string' ? input.name.trim().slice(0, 200) : '';
    const ek = await this.transport.unwrap(input.requestId, input.transport, input.vaultId, input.vaultEpoch);
    try {
      const info = (await this.cloud.listCollections?.().catch(() => []))?.find(entry => entry?.id === input.collectionId)?.info;
      return await this.restoreWithKey(ek, { collectionId: input.collectionId, name, vaultId: input.vaultId, vaultEpoch: input.vaultEpoch, info });
    } finally {
      ek.fill(0);
    }
  }

  /** The caller owns ek and zeroes it; restore-all reuses one escrow key for every collection. */
  async restoreWithKey(ek:Uint8Array, input:RestoreWithKeyInput):Promise<{ restored:true; collectionId:string }> {
    if (!isUuid(input?.collectionId) || !isUuid(input.vaultId) || !Number.isSafeInteger(input.vaultEpoch) || input.vaultEpoch < 1) {
      throw new RestoreError(400, 'invalid_request', 'Restore request is invalid');
    }
    let root:Uint8Array | undefined;
    let local:{ keyVersion:number; root:Buffer | null } | null = null;
    try {
      const keys = await this.cloud.keys(input.collectionId);
      const match = keys
        .filter(entry => validEscrow(entry?.escrow, input.collectionId, input.vaultId, input.vaultEpoch) && (entry.escrow as EscrowEnvelope).keyVersion === entry.keyVersion)
        .sort((left, right) => right.keyVersion - left.keyVersion)[0];
      if (!match) throw new RestoreError(409, 'escrow_not_found', 'This backup is not protected by the unlocked vault');
      const escrow = match.escrow as EscrowEnvelope;
      try {
        root = await openEscrowWithKey(ek, escrow);
      } catch {
        throw new RestoreError(409, 'escrow_rejected', 'The unlocked vault cannot open this backup');
      }
      const page = await this.cloud.changes(input.collectionId, 0, 1);
      if (!page?.head || page.head.collectionId !== input.collectionId || page.head.keyVersion !== escrow.keyVersion || !await verifyHead(root, page.head)) {
        throw new RestoreError(409, 'head_rejected', 'The cloud backup failed verification');
      }
      local = await this.target.localRoot(input.collectionId);
      if (local?.root && (local.keyVersion !== escrow.keyVersion || !timingSafeEqual(local.root, Buffer.from(root)))) {
        throw new RestoreError(409, 'collection_conflict', 'A different local collection already uses this id');
      }
      if (!local) await this.target.createCollection(input.collectionId, await this.folderName(root, input, escrow.keyVersion) || input.name.trim().slice(0, 200) || 'Restored files');
      await this.target.install(input.collectionId, escrow.keyVersion, root, input.vaultId, input.vaultEpoch);
      return { restored: true, collectionId: input.collectionId };
    } finally {
      root?.fill(0);
      local?.root?.fill(0);
    }
  }

  /** The folder name the backing-up Desktop sealed with this root, or '' when there is none we can verify. */
  private async folderName(root:Uint8Array, input:RestoreWithKeyInput, keyVersion:number):Promise<string> {
    const info = input.info as CollectionInfoEnvelope | undefined;
    if (!info || info.collectionId !== input.collectionId || info.keyVersion !== keyVersion) return '';
    try {
      return (await openCollectionInfo(root, info)).name.trim().slice(0, 200);
    } catch {
      return '';
    }
  }
}

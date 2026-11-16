// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

import type { FilesIdentity } from '../auth.js';
import { PgCloudChunkMapRepository } from '../Repositories/CloudChunkMapRepository.js';
import { PgCloudCollectionCatalogRepository } from '../Repositories/CloudCollectionCatalogRepository.js';
import { PgCloudFileHeadRepository } from '../Repositories/CloudFileHeadRepository.js';
import { PgCloudOperationQueueRepository } from '../Repositories/CloudOperationQueueRepository.js';
import { PgCloudPushProgressRepository } from '../Repositories/CloudPushProgressRepository.js';
import { PgCloudRemoteFileRepository } from '../Repositories/CloudRemoteFileRepository.js';
import { PgCloudRemoteFolderRepository } from '../Repositories/CloudRemoteFolderRepository.js';
import { PgCloudSyncStateRepository } from '../Repositories/CloudSyncStateRepository.js';
import type { SyncHead, StateEntry } from './envelope.js';
import type { ApplyRemoteInput, ForkLocalInput, LocalFileState, PullRepository } from './pull.js';
import type { CloudPushSource } from './repository.js';
import type { RemoteVersion } from './validation.js';

/** Everything the puller needs, routed to the repository that owns each table. */
export class CloudPullStore implements PullRepository {
  constructor(
    private readonly heads:PgCloudFileHeadRepository,
    private readonly files:PgCloudRemoteFileRepository,
    private readonly folders:PgCloudRemoteFolderRepository,
    private readonly state:PgCloudSyncStateRepository,
  ) {}

  cloudHeadPages(collectionId:string):AsyncIterable<StateEntry[]> { return this.heads.cloudHeadPages(collectionId) }
  hasLocalVersion(versionId:string):Promise<boolean> { return this.files.hasLocalVersion(versionId) }
  isCloudVersion(versionId:string):Promise<boolean> { return this.files.isCloudVersion(versionId) }
  versionParent(versionId:string):Promise<string | null | undefined> { return this.files.versionParent(versionId) }
  localFile(collectionId:string, fileId:string):Promise<LocalFileState | null> { return this.files.localFile(collectionId, fileId) }
  forkLocalVersion(input:ForkLocalInput):Promise<void> { return this.files.forkLocalVersion(input) }
  applyRemoteVersion(input:ApplyRemoteInput):Promise<void> { return this.files.applyRemoteVersion(input) }
  applyRemoteFolderVersion(input:ApplyRemoteInput):Promise<void> { return this.folders.applyRemoteFolderVersion(input) }
  recordCloudHead(collectionId:string, remote:RemoteVersion):Promise<void> { return this.heads.recordCloudHead(collectionId, remote) }
  saveVerifiedHead(collectionId:string, head:SyncHead):Promise<void> { return this.state.saveVerifiedHead(collectionId, head) }
  cloudFolderPath(collectionId:string, fileId:string):Promise<string | null> { return this.folders.cloudFolderPath(collectionId, fileId) }
}

/** What the uploader reads and records while staging one version. */
export class CloudPushStore implements CloudPushSource {
  constructor(
    private readonly progress:PgCloudPushProgressRepository,
    private readonly chunks:PgCloudChunkMapRepository,
    private readonly heads:PgCloudFileHeadRepository,
  ) {}

  pushCursor(collectionId:string) { return this.progress.pushCursor(collectionId) }
  chunkSize(collectionId:string, chunkId:string) { return this.chunks.chunkSize(collectionId, chunkId) }
  uploadedCopy(collectionId:string, localChunkId:string) { return this.chunks.uploadedCopy(collectionId, localChunkId) }
  recordSealedChunk(collectionId:string, localChunkId:string, cloudChunkId:string, cipherSha256:string, cipherBytes:number) {
    return this.chunks.recordSealedChunk(collectionId, localChunkId, cloudChunkId, cipherSha256, cipherBytes);
  }
  cloudHead(collectionId:string, fileId:string) { return this.heads.cloudHead(collectionId, fileId) }
}

/** Builds every cloud-sync repository once, at composition, around one pool and one actor. */
export class CloudSyncRepositories {
  readonly catalog:PgCloudCollectionCatalogRepository;
  readonly state:PgCloudSyncStateRepository;
  readonly operations:PgCloudOperationQueueRepository;
  readonly chunks:PgCloudChunkMapRepository;
  readonly heads:PgCloudFileHeadRepository;
  readonly progress:PgCloudPushProgressRepository;
  readonly pull:CloudPullStore;
  readonly push:CloudPushStore;

  constructor(db:pg.Pool, actor:FilesIdentity) {
    this.catalog = new PgCloudCollectionCatalogRepository(db);
    this.state = new PgCloudSyncStateRepository(db);
    this.operations = new PgCloudOperationQueueRepository(db);
    this.chunks = new PgCloudChunkMapRepository(db);
    this.heads = new PgCloudFileHeadRepository(db);
    this.progress = new PgCloudPushProgressRepository(db, this.heads);
    this.pull = new CloudPullStore(this.heads, new PgCloudRemoteFileRepository(db, actor, this.heads), new PgCloudRemoteFolderRepository(db, actor, this.heads), this.state);
    this.push = new CloudPushStore(this.progress, this.chunks, this.heads);
  }
}

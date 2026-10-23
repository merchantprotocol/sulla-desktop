import { randomUUID } from 'node:crypto';

import type { ChangesPage } from './cloudApi.js';
import { openManifest, stateHash, type ManifestPlain, type StateEntry, type SyncHead } from './envelope.js';
import {
  assertRemoteMatchesManifest,
  CloudSyncIntegrityError,
  conflictPath,
  parseManifestPlain,
  parseRemoteVersion,
  validateHeadAdvance,
  type RemoteVersion,
} from './validation.js';

export const CHANGES_PAGE_LIMIT = 500;

export interface LocalFileState {
  path:string;
  currentVersionId:string | null;
  /** The current local version is a deletion. */
  deleted:boolean;
}

/** Local chunks that hold a remote version's plaintext, ready to reference from a new local version. */
export interface MaterializedContent {
  chunkIds:string[];
  chunks:Array<{ id:string; size:number; storedSize:number }>;
}

export interface ForkLocalInput {
  collectionId:string;
  fileId:string;
  versionId:string;
  newFileId:string;
  newVersionId:string;
  path:string;
}

export interface ApplyRemoteInput {
  collectionId:string;
  remote:RemoteVersion;
  manifest:ManifestPlain;
  /** null for deletions. */
  content:MaterializedContent | null;
  /** Used to name a conflicted copy when the remote path is taken by another local file. */
  remoteDeviceLabel:string;
}

/** Everything the puller needs from the database. PgCloudSyncRepository implements it. */
export interface PullRepository {
  /** Per-file cloud heads this device last saw (files_cloud_file_heads). */
  cloudHeads(collectionId:string):Promise<StateEntry[]>;
  /** The version already exists locally (we pushed it, or applied it before). */
  hasLocalVersion(versionId:string):Promise<boolean>;
  /** The version is known to Cloud: pushed from here or applied from a pull. */
  isCloudVersion(versionId:string):Promise<boolean>;
  localFile(collectionId:string, fileId:string):Promise<LocalFileState | null>;
  /** Preserve a local version as a new file with the same content and a 'conflict' journal op. */
  forkLocalVersion(input:ForkLocalInput):Promise<void>;
  /** Apply a remote version onto its original fileId and record it as the file's cloud head. */
  applyRemoteVersion(input:ApplyRemoteInput):Promise<void>;
  /** Record a cloud head for a version that is already present locally. */
  recordCloudHead(collectionId:string, remote:RemoteVersion):Promise<void>;
  saveVerifiedHead(collectionId:string, head:SyncHead):Promise<void>;
}

export interface RemoteContentSource {
  materialize(collectionId:string, keyVersion:number, root:Uint8Array, manifest:ManifestPlain):Promise<MaterializedContent>;
}

export interface PullState {
  collectionId:string;
  keyVersion:number;
  lastSeq:number;
  head:SyncHead | null;
}

export interface PullResult { applied:number; conflicts:number; head:SyncHead }

interface OpenedVersion { remote:RemoteVersion; manifest:ManifestPlain }

/**
 * Pull = fetch every page since lastSeq, verify the head and every manifest
 * before touching local state, then apply in seq order. Conflicts keep both:
 * an unpushed local edit is copied to a new file before the remote version
 * lands on the original fileId.
 */
export class CloudPuller {
  constructor(
    private readonly api:{ changes(collectionId:string, since:number, limit:number):Promise<ChangesPage> },
    private readonly repository:PullRepository,
    private readonly content:RemoteContentSource,
    private readonly deviceName:string,
    private readonly now:() => Date = () => new Date(),
  ) {}

  async pull(state:PullState, root:Uint8Array):Promise<PullResult> {
    const { versions, head } = await this.fetchAll(state);
    await validateHeadAdvance(root, head, {
      collectionId: state.collectionId,
      keyVersion: state.keyVersion,
      lastSeq: state.lastSeq,
      lastMac: state.head?.mac ?? '',
    });
    if (versions.some(version => version.seq > head.seq)) throw new CloudSyncIntegrityError('cloud versions are newer than the cloud head');
    const opened = await this.openAll(state, root, versions);
    await this.assertStateHash(state.collectionId, opened, head);

    let applied = 0;
    let conflicts = 0;
    for (const version of opened) {
      const outcome = await this.applyOne(state, root, version);
      if (outcome !== 'known') applied += 1;
      if (outcome === 'forked') conflicts += 1;
    }
    await this.repository.saveVerifiedHead(state.collectionId, head);
    return { applied, conflicts, head };
  }

  /** Pages through changes until caught up. Versions sharing the last seq of a full page are re-read, never skipped. */
  private async fetchAll(state:PullState):Promise<{ versions:RemoteVersion[]; head:SyncHead }> {
    const byId = new Map<string, RemoteVersion>();
    let since = state.lastSeq;
    let head:SyncHead | undefined;
    for (;;) {
      const page = await this.api.changes(state.collectionId, since, CHANGES_PAGE_LIMIT);
      head = page.head;
      const parsed = page.versions.map(value => parseRemoteVersion(value, state.collectionId, state.keyVersion));
      for (const version of parsed) {
        if (version.seq <= state.lastSeq) continue;
        byId.set(version.versionId, version);
      }
      if (parsed.length < CHANGES_PAGE_LIMIT) break;
      const maxSeq = Math.max(...parsed.map(version => version.seq));
      const next = maxSeq - 1 > since ? maxSeq - 1 : maxSeq;
      if (next <= since) throw new CloudSyncIntegrityError('cloud changes paging did not advance');
      since = next;
    }
    const versions = [...byId.values()].sort((left, right) => left.seq - right.seq || left.versionId.localeCompare(right.versionId));
    return { versions, head: head! };
  }

  private async openAll(state:PullState, root:Uint8Array, versions:RemoteVersion[]):Promise<OpenedVersion[]> {
    const opened:OpenedVersion[] = [];
    for (const remote of versions) {
      let plain:unknown;
      try {
        plain = await openManifest(root, remote.manifest);
      } catch {
        throw new CloudSyncIntegrityError('cloud manifest failed authentication');
      }
      const manifest = parseManifestPlain(plain);
      assertRemoteMatchesManifest(remote, manifest);
      opened.push({ remote, manifest });
    }
    return opened;
  }

  /** stateHash is over every file's cloud head after this page, never over local files (which may hold unpushed edits). */
  private async assertStateHash(collectionId:string, opened:OpenedVersion[], head:SyncHead):Promise<void> {
    const projected = new Map<string, StateEntry>();
    for (const entry of await this.repository.cloudHeads(collectionId)) projected.set(entry.fileId, entry);
    for (const { remote } of opened) {
      projected.set(remote.fileId, { fileId: remote.fileId, versionId: remote.versionId, deleted: remote.deleted });
    }
    if (await stateHash([...projected.values()]) !== head.stateHash) {
      throw new CloudSyncIntegrityError('cloud head state does not match the listed versions');
    }
  }

  private async applyOne(state:PullState, root:Uint8Array, { remote, manifest }:OpenedVersion):Promise<'known' | 'applied' | 'forked'> {
    if (await this.repository.hasLocalVersion(remote.versionId)) {
      await this.repository.recordCloudHead(state.collectionId, remote);
      return 'known';
    }
    const local = await this.repository.localFile(state.collectionId, remote.fileId);
    let forked = false;
    if (local?.currentVersionId && local.currentVersionId !== remote.parentVersionId && !local.deleted &&
        !await this.repository.isCloudVersion(local.currentVersionId)) {
      // The local edit was never pushed and the remote did not build on it: keep a real copy of it first.
      await this.repository.forkLocalVersion({
        collectionId: state.collectionId,
        fileId: remote.fileId,
        versionId: local.currentVersionId,
        newFileId: randomUUID(),
        newVersionId: randomUUID(),
        path: conflictPath(local.path, this.deviceName, this.now()),
      });
      forked = true;
    }
    const content = manifest.deleted ? null : await this.content.materialize(state.collectionId, state.keyVersion, root, manifest);
    await this.repository.applyRemoteVersion({
      collectionId: state.collectionId,
      remote,
      manifest,
      content,
      remoteDeviceLabel: (remote.deviceId ?? 'cloud').slice(0, 8),
    });
    return forked ? 'forked' : 'applied';
  }
}

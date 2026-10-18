import { webContents } from 'electron';

import { ChatArtifactModel } from '../database/models/ChatArtifactModel';

import Logging from '@pkg/utils/logging';

import type {
  ChatArtifactAuthor,
  ChatArtifactChangedEvent,
  ChatArtifactKind,
  ChatArtifactRecord,
  ChatArtifactRevision,
  ChatArtifactStatus,
} from '@pkg/shared/chatArtifacts';

const VALID_KINDS = new Set<ChatArtifactKind>(['markdown', 'html', 'code']);
const VALID_STATUSES = new Set<ChatArtifactStatus>(['working', 'done', 'error', 'viewing', 'editing']);
const console = Logging.background;

export interface CreateArtifactInput {
  name:       string;
  kind?:      ChatArtifactKind;
  content:    string;
  status?:    ChatArtifactStatus;
  language?:  string | null;
  path?:      string | null;
  author?:    ChatArtifactAuthor;
  focus?:     boolean;
  expectedVersion?: number;
}

export interface UpdateArtifactInput {
  content?:         string;
  name?:            string;
  status?:          ChatArtifactStatus;
  language?:        string | null;
  path?:            string | null;
  expectedVersion?: number;
  author?:          ChatArtifactAuthor;
  focus?:           boolean;
}

export interface ExactEdit {
  find:    string;
  replace: string;
}

export interface CreateArtifactResult {
  artifact: ChatArtifactRecord;
  created:  boolean;
}

interface ChatArtifactStore {
  list(threadId: string, includeClosed?: boolean): Promise<ChatArtifactRecord[]>;
  get(threadId: string, idOrName: string, includeDeleted?: boolean): Promise<ChatArtifactRecord | null>;
  create(input: Parameters<typeof ChatArtifactModel.create>[0]): Promise<ChatArtifactRecord>;
  mutate(input: Parameters<typeof ChatArtifactModel.mutate>[0]): Promise<ChatArtifactRecord>;
  history(threadId: string, idOrName: string): Promise<ChatArtifactRevision[]>;
  revision(threadId: string, idOrName: string, version: number): Promise<ChatArtifactRevision | null>;
  recordFilesRegistration(
    artifactId: string,
    artifactVersion: number,
    result: FilesRegistrationResult | { error: string; path?: string },
  ): Promise<ChatArtifactRecord | null>;
}

export interface ArtifactBookmarkSync {
  created(artifact: ChatArtifactRecord): Promise<void>;
  renamed(artifact: ChatArtifactRecord): Promise<void>;
  deleted(artifact: ChatArtifactRecord): Promise<void>;
}

export interface FilesRegistrationResult {
  fileId:       string;
  versionId:    string;
  collectionId: string;
  path:         string;
}

export interface ArtifactFilesRegistration {
  register(artifact: ChatArtifactRecord): Promise<FilesRegistrationResult>;
}

function required(value: unknown, label: string): string {
  const clean = typeof value === 'string' ? value.trim() : '';
  if (!clean) throw new Error(`${ label } is required.`);
  return clean;
}

function cleanKind(value: unknown): ChatArtifactKind {
  const kind = (value || 'markdown') as ChatArtifactKind;
  if (!VALID_KINDS.has(kind)) throw new Error(`Unsupported artifact kind "${ String(value) }".`);
  return kind;
}

function cleanStatus(value: unknown, fallback: ChatArtifactStatus = 'working'): ChatArtifactStatus {
  if (value === undefined || value === null || value === '') return fallback;
  const status = value as ChatArtifactStatus;
  if (!VALID_STATUSES.has(status)) throw new Error(`Unsupported artifact status "${ String(value) }".`);
  return status;
}

export class ChatArtifactService {
  constructor(
    private readonly store: ChatArtifactStore = ChatArtifactModel,
    private bookmarkSync: ArtifactBookmarkSync | null = configuredBookmarkSync,
    private filesRegistration: ArtifactFilesRegistration | null = configuredFilesRegistration,
  ) {}

  setBookmarkSync(sync: ArtifactBookmarkSync): void {
    this.bookmarkSync = sync;
  }

  setFilesRegistration(registration: ArtifactFilesRegistration): void {
    this.filesRegistration = registration;
  }

  async list(threadId: string, includeClosed = false): Promise<ChatArtifactRecord[]> {
    const artifacts = await this.store.list(required(threadId, 'threadId'), includeClosed);
    return Promise.all(artifacts.map(artifact => artifact.filesRegistrationStatus === 'pending' ? this.syncFiles(artifact) : artifact));
  }

  async get(threadId: string, idOrName: string): Promise<ChatArtifactRecord> {
    const artifact = await this.store.get(required(threadId, 'threadId'), required(idOrName, 'artifact id or name'));
    if (!artifact) throw new Error(`Artifact "${ idOrName }" was not found in this chat.`);
    return artifact;
  }

  async create(threadId: string, input: CreateArtifactInput): Promise<CreateArtifactResult> {
    const scopedThreadId = required(threadId, 'threadId');
    const name = required(input.name, 'Artifact name');
    const existing = await this.store.get(scopedThreadId, name, true);

    if (existing) {
      const wasDeleted = existing.isDeleted;
      let artifact = await this.store.mutate({
        threadId: scopedThreadId,
        idOrName: existing.id,
        author:   input.author ?? 'agent',
        expectedVersion: input.expectedVersion,
        mutate:   current => ({
          name,
          kind:      cleanKind(input.kind),
          content:   String(input.content ?? ''),
          status:    cleanStatus(input.status, current.status),
          isOpen:    true,
          isDeleted: false,
          language:  input.language === undefined ? current.language : input.language,
          path:      input.path === undefined ? current.path : input.path,
        }),
      });
      this.publish(scopedThreadId, artifact, input.focus ?? true);
      if (wasDeleted) this.syncBookmark('created', artifact);
      artifact = await this.syncFiles(artifact);
      return { artifact, created: false };
    }

    let artifact = await this.store.create({
      threadId: scopedThreadId,
      name,
      kind:     cleanKind(input.kind),
      content:  String(input.content ?? ''),
      status:   cleanStatus(input.status),
      language: input.language,
      path:     input.path,
      author:   input.author ?? 'agent',
    });
    this.publish(scopedThreadId, artifact, input.focus ?? true);
    this.syncBookmark('created', artifact);
    artifact = await this.syncFiles(artifact);
    return { artifact, created: true };
  }

  /** Open is create-by-name: existing artifacts are updated and reopened, never duplicated. */
  open(threadId: string, input: CreateArtifactInput): Promise<CreateArtifactResult> {
    return this.create(threadId, input);
  }

  async update(threadId: string, idOrName: string, input: UpdateArtifactInput): Promise<ChatArtifactRecord> {
    let artifact = await this.mutate(threadId, idOrName, input, current => ({
      content:  input.content === undefined ? current.content : String(input.content),
      name:     input.name === undefined ? current.name : required(input.name, 'Artifact name'),
      status:   input.status === undefined ? current.status : cleanStatus(input.status),
      language: input.language === undefined ? current.language : input.language,
      path:     input.path === undefined ? current.path : input.path,
    }));
    this.publish(artifact.threadId, artifact, input.focus);
    if (input.name !== undefined) this.syncBookmark('renamed', artifact);
    artifact = await this.syncFiles(artifact);
    return artifact;
  }

  async edit(
    threadId: string,
    idOrName: string,
    edits: ExactEdit[],
    expectedVersion?: number,
    author: ChatArtifactAuthor = 'agent',
  ): Promise<ChatArtifactRecord> {
    if (!Array.isArray(edits) || edits.length === 0) throw new Error('At least one exact edit is required.');
    let artifact = await this.mutate(threadId, idOrName, { expectedVersion, author }, (current) => {
      let content = current.content;

      for (const [index, edit] of edits.entries()) {
        const find = String(edit?.find ?? '');
        if (!find) throw new Error(`Edit ${ index + 1 } has an empty find value.`);
        const matches = content.split(find).length - 1;
        if (matches !== 1) {
          throw new Error(`Edit ${ index + 1 } must match exactly once, but matched ${ matches } time(s). No changes were saved.`);
        }
        // split/join, not replace(): a string replacement would expand `$&`, `$1`, etc.
        content = content.split(find).join(String(edit.replace ?? ''));
      }

      return { content };
    });
    this.publish(artifact.threadId, artifact);
    artifact = await this.syncFiles(artifact);
    return artifact;
  }

  async append(
    threadId: string,
    idOrName: string,
    text: string,
    expectedVersion?: number,
    author: ChatArtifactAuthor = 'agent',
  ): Promise<ChatArtifactRecord> {
    let artifact = await this.mutate(threadId, idOrName, { expectedVersion, author }, current => ({
      content: current.content + String(text ?? ''),
    }));
    this.publish(artifact.threadId, artifact);
    artifact = await this.syncFiles(artifact);
    return artifact;
  }

  setStatus(threadId: string, idOrName: string, status: ChatArtifactStatus, expectedVersion?: number, author: ChatArtifactAuthor = 'agent'): Promise<ChatArtifactRecord> {
    return this.update(threadId, idOrName, { status: cleanStatus(status), expectedVersion, author });
  }

  rename(threadId: string, idOrName: string, name: string, expectedVersion?: number, author: ChatArtifactAuthor = 'agent'): Promise<ChatArtifactRecord> {
    return this.update(threadId, idOrName, { name, expectedVersion, author });
  }

  async focus(threadId: string, idOrName: string): Promise<ChatArtifactRecord> {
    const artifact = await this.get(threadId, idOrName);
    if (!artifact.isOpen) throw new Error('Artifact is closed. Reopen it before focusing it.');
    this.publish(artifact.threadId, artifact, true);
    return artifact;
  }

  close(threadId: string, idOrName: string, expectedVersion?: number, author: ChatArtifactAuthor = 'agent'): Promise<ChatArtifactRecord> {
    return this.setOpen(threadId, idOrName, false, expectedVersion, author);
  }

  reopen(threadId: string, idOrName: string, expectedVersion?: number, author: ChatArtifactAuthor = 'agent'): Promise<ChatArtifactRecord> {
    return this.setOpen(threadId, idOrName, true, expectedVersion, author);
  }

  async delete(threadId: string, idOrName: string, expectedVersion?: number, author: ChatArtifactAuthor = 'agent'): Promise<ChatArtifactRecord> {
    const artifact = await this.mutate(threadId, idOrName, { expectedVersion, author }, () => ({ isOpen: false, isDeleted: true }));
    this.publish(artifact.threadId, artifact);
    this.syncBookmark('deleted', artifact);
    return artifact;
  }

  history(threadId: string, idOrName: string): Promise<ChatArtifactRevision[]> {
    return this.store.history(required(threadId, 'threadId'), required(idOrName, 'artifact id or name'));
  }

  async revert(
    threadId: string,
    idOrName: string,
    version: number,
    expectedVersion?: number,
    author: ChatArtifactAuthor = 'agent',
  ): Promise<ChatArtifactRecord> {
    const revision = await this.store.revision(required(threadId, 'threadId'), required(idOrName, 'artifact id or name'), version);
    if (!revision) throw new Error(`Artifact revision ${ version } was not found.`);
    let artifact = await this.mutate(threadId, idOrName, { expectedVersion, author }, () => ({ content: revision.content }));
    this.publish(artifact.threadId, artifact);
    artifact = await this.syncFiles(artifact);
    return artifact;
  }

  async retryFilesRegistration(threadId: string, idOrName: string): Promise<ChatArtifactRecord> {
    const artifact = await this.get(threadId, idOrName);
    if (artifact.filesRegistrationStatus === 'synced' && artifact.filesArtifactVersion === artifact.version) return artifact;
    return this.syncFiles(artifact, true);
  }

  private mutate(
    threadId: string,
    idOrName: string,
    input: Pick<UpdateArtifactInput, 'expectedVersion' | 'author'>,
    mutate: Parameters<ChatArtifactStore['mutate']>[0]['mutate'],
  ): Promise<ChatArtifactRecord> {
    return this.store.mutate({
      threadId: required(threadId, 'threadId'),
      idOrName: required(idOrName, 'artifact id or name'),
      author: input.author ?? 'agent',
      expectedVersion: input.expectedVersion,
      mutate: current => {
        if (current.isDeleted) throw new Error('Artifact is deleted. Create it again by the same name to restore it.');
        return mutate(current);
      },
    });
  }

  private async setOpen(
    threadId: string,
    idOrName: string,
    isOpen: boolean,
    expectedVersion?: number,
    author: ChatArtifactAuthor = 'agent',
  ): Promise<ChatArtifactRecord> {
    const artifact = await this.mutate(threadId, idOrName, { expectedVersion, author }, () => ({ isOpen }));
    this.publish(artifact.threadId, artifact, isOpen);
    return artifact;
  }

  private publish(threadId: string, artifact: ChatArtifactRecord, focus = false): void {
    const payload: ChatArtifactChangedEvent = { threadId, artifact, ...(focus ? { focus: true } : {}) };
    for (const contents of webContents.getAllWebContents()) {
      try {
        if (!contents.isDestroyed()) contents.send('chat-artifacts:changed', payload);
      } catch { /* A disposed window must not turn a committed DB write into a tool failure. */ }
    }
  }

  private syncBookmark(action: keyof ArtifactBookmarkSync, artifact: ChatArtifactRecord): void {
    const sync = this.bookmarkSync;
    if (!sync) return;
    Promise.resolve()
      .then(() => sync[action](artifact))
      .catch(err => console.warn(`[ChatArtifactService] Bookmark ${ action } sync failed:`, err));
  }

  private syncFiles(artifact: ChatArtifactRecord, force = false): Promise<ChatArtifactRecord> {
    if (!this.filesRegistration || artifact.isDeleted ||
        (!force && artifact.filesRegistrationStatus === 'synced')) return Promise.resolve(artifact);

    const previous = filesRegistrationQueues.get(artifact.id) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async() => {
      let persisted: ChatArtifactRecord | null;
      try {
        const result = await this.filesRegistration!.register(artifact);
        persisted = await this.store.recordFilesRegistration(artifact.id, artifact.version, result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const filesPath = typeof (error as { filesPath?: unknown })?.filesPath === 'string'
          ? (error as { filesPath: string }).filesPath
          : undefined;
        persisted = await this.store.recordFilesRegistration(artifact.id, artifact.version, { error: message, path: filesPath });
        console.warn(`[ChatArtifactService] Files registration failed for ${ artifact.id } v${ artifact.version }:`, message);
      }
      if (persisted) this.publish(persisted.threadId, persisted);
      return persisted ?? artifact;
    });
    const queued = operation.then(() => undefined, () => undefined);
    filesRegistrationQueues.set(artifact.id, queued);
    return operation.finally(() => {
      if (filesRegistrationQueues.get(artifact.id) === queued) filesRegistrationQueues.delete(artifact.id);
    });
  }
}

let instance: ChatArtifactService | null = null;
let configuredBookmarkSync: ArtifactBookmarkSync | null = null;
let configuredFilesRegistration: ArtifactFilesRegistration | null = null;
const filesRegistrationQueues = new Map<string, Promise<void>>();

export function configureChatArtifactBookmarkSync(sync: ArtifactBookmarkSync): void {
  configuredBookmarkSync = sync;
  instance?.setBookmarkSync(sync);
}

export function configureChatArtifactFilesRegistration(registration: ArtifactFilesRegistration): void {
  configuredFilesRegistration = registration;
  instance?.setFilesRegistration(registration);
}

export function getChatArtifactService(): ChatArtifactService {
  instance ??= new ChatArtifactService();
  return instance;
}

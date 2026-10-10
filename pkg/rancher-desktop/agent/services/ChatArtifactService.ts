import { webContents } from 'electron';

import { ChatArtifactModel } from '../database/models/ChatArtifactModel';

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
  constructor(private readonly store: ChatArtifactStore = ChatArtifactModel) {}

  list(threadId: string, includeClosed = false): Promise<ChatArtifactRecord[]> {
    return this.store.list(required(threadId, 'threadId'), includeClosed);
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
      const artifact = await this.store.mutate({
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
      return { artifact, created: false };
    }

    const artifact = await this.store.create({
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
    return { artifact, created: true };
  }

  /** Open is create-by-name: existing artifacts are updated and reopened, never duplicated. */
  open(threadId: string, input: CreateArtifactInput): Promise<CreateArtifactResult> {
    return this.create(threadId, input);
  }

  async update(threadId: string, idOrName: string, input: UpdateArtifactInput): Promise<ChatArtifactRecord> {
    const artifact = await this.mutate(threadId, idOrName, input, current => ({
      content:  input.content === undefined ? current.content : String(input.content),
      name:     input.name === undefined ? current.name : required(input.name, 'Artifact name'),
      status:   input.status === undefined ? current.status : cleanStatus(input.status),
      language: input.language === undefined ? current.language : input.language,
      path:     input.path === undefined ? current.path : input.path,
    }));
    this.publish(artifact.threadId, artifact, input.focus);
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
    const artifact = await this.mutate(threadId, idOrName, { expectedVersion, author }, (current) => {
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
    return artifact;
  }

  async append(
    threadId: string,
    idOrName: string,
    text: string,
    expectedVersion?: number,
    author: ChatArtifactAuthor = 'agent',
  ): Promise<ChatArtifactRecord> {
    const artifact = await this.mutate(threadId, idOrName, { expectedVersion, author }, current => ({
      content: current.content + String(text ?? ''),
    }));
    this.publish(artifact.threadId, artifact);
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
    const artifact = await this.mutate(threadId, idOrName, { expectedVersion, author }, () => ({ content: revision.content }));
    this.publish(artifact.threadId, artifact);
    return artifact;
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
}

let instance: ChatArtifactService | null = null;

export function getChatArtifactService(): ChatArtifactService {
  instance ??= new ChatArtifactService();
  return instance;
}

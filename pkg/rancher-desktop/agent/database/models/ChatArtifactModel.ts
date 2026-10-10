import { randomBytes } from 'node:crypto';

import type { PoolClient } from 'pg';

import { postgresClient } from '../PostgresClient';

import type {
  ChatArtifactAuthor,
  ChatArtifactKind,
  ChatArtifactRecord,
  ChatArtifactRevision,
  ChatArtifactStatus,
} from '@pkg/shared/chatArtifacts';

interface ChatArtifactRow {
  id:         string;
  thread_id:  string;
  name:       string;
  kind:       ChatArtifactKind;
  content:    string;
  status:     ChatArtifactStatus;
  is_open:    boolean;
  is_deleted: boolean;
  version:    number;
  language:   string | null;
  path:       string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

interface ChatArtifactRevisionRow {
  artifact_id: string;
  version:     number;
  content:     string;
  author:      ChatArtifactAuthor;
  created_at:  string | Date;
}

export interface CreateChatArtifactInput {
  threadId: string;
  name:     string;
  kind:     ChatArtifactKind;
  content:  string;
  status:   ChatArtifactStatus;
  language?: string | null;
  path?:     string | null;
  author:    ChatArtifactAuthor;
}

export interface MutateChatArtifactInput {
  threadId: string;
  idOrName: string;
  author:   ChatArtifactAuthor;
  expectedVersion?: number;
  mutate: (record: ChatArtifactRecord) => Partial<Pick<ChatArtifactRecord,
    'name' | 'kind' | 'content' | 'status' | 'isOpen' | 'isDeleted' | 'language' | 'path'>>;
}

function mapArtifact(row: ChatArtifactRow): ChatArtifactRecord {
  return {
    id: row.id, threadId: row.thread_id, name: row.name, kind: row.kind,
    content: row.content, status: row.status, isOpen: row.is_open,
    isDeleted: row.is_deleted, version: row.version, language: row.language,
    path: row.path, createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at),
  };
}

function mapRevision(row: ChatArtifactRevisionRow): ChatArtifactRevision {
  return {
    artifactId: row.artifact_id, version: row.version, content: row.content,
    author: row.author, createdAt: timestamp(row.created_at),
  };
}

function timestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function newId(): string {
  return `ca_${ Date.now().toString(36) }_${ randomBytes(5).toString('hex') }`;
}

async function findForUpdate(client: PoolClient, threadId: string, idOrName: string): Promise<ChatArtifactRow | null> {
  const result = await client.query<ChatArtifactRow>(
    `SELECT * FROM chat_artifacts
      WHERE thread_id = $1 AND (id = $2 OR LOWER(name) = LOWER($2))
      LIMIT 1 FOR UPDATE`,
    [threadId, idOrName],
  );

  return result.rows[0] ?? null;
}

export class ChatArtifactModel {
  static async list(threadId: string, includeClosed = false): Promise<ChatArtifactRecord[]> {
    const rows = await postgresClient.query<ChatArtifactRow>(
      `SELECT * FROM chat_artifacts
        WHERE thread_id = $1 AND is_deleted = false AND ($2::boolean OR is_open = true)
        ORDER BY created_at, id`,
      [threadId, includeClosed],
    );

    return rows.map(mapArtifact);
  }

  static async get(threadId: string, idOrName: string, includeDeleted = false): Promise<ChatArtifactRecord | null> {
    const row = await postgresClient.queryOne<ChatArtifactRow>(
      `SELECT * FROM chat_artifacts
        WHERE thread_id = $1 AND (id = $2 OR LOWER(name) = LOWER($2))
          AND ($3::boolean OR is_deleted = false)
        LIMIT 1`,
      [threadId, idOrName, includeDeleted],
    );

    return row ? mapArtifact(row) : null;
  }

  static async create(input: CreateChatArtifactInput): Promise<ChatArtifactRecord> {
    return postgresClient.transaction(async(client) => {
      const id = newId();
      const result = await client.query<ChatArtifactRow>(
        `INSERT INTO chat_artifacts
          (id, thread_id, name, kind, content, status, language, path)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [id, input.threadId, input.name, input.kind, input.content, input.status, input.language ?? null, input.path ?? null],
      );
      const row = result.rows[0];

      await client.query(
        `INSERT INTO chat_artifact_revisions (artifact_id, version, content, author)
         VALUES ($1, $2, $3, $4)`,
        [row.id, row.version, row.content, input.author],
      );

      return mapArtifact(row);
    });
  }

  static async mutate(input: MutateChatArtifactInput): Promise<ChatArtifactRecord> {
    return postgresClient.transaction(async(client) => {
      const row = await findForUpdate(client, input.threadId, input.idOrName);
      if (!row) throw new Error(`Artifact "${ input.idOrName }" was not found in this chat.`);
      if (input.expectedVersion !== undefined && row.version !== input.expectedVersion) {
        throw new Error(`Artifact version conflict: expected ${ input.expectedVersion }, current version is ${ row.version }. Read it again before editing.`);
      }

      const current = mapArtifact(row);
      const patch = input.mutate(current);
      const result = await client.query<ChatArtifactRow>(
        `UPDATE chat_artifacts SET
           name = $3, kind = $4, content = $5, status = $6,
           is_open = $7, is_deleted = $8, language = $9, path = $10,
           version = version + 1, updated_at = NOW()
         WHERE thread_id = $1 AND id = $2
         RETURNING *`,
        [
          input.threadId, row.id, patch.name ?? current.name, patch.kind ?? current.kind,
          patch.content ?? current.content, patch.status ?? current.status,
          patch.isOpen ?? current.isOpen, patch.isDeleted ?? current.isDeleted,
          patch.language === undefined ? current.language : patch.language,
          patch.path === undefined ? current.path : patch.path,
        ],
      );
      const updated = result.rows[0];

      await client.query(
        `INSERT INTO chat_artifact_revisions (artifact_id, version, content, author)
         VALUES ($1, $2, $3, $4)`,
        [updated.id, updated.version, updated.content, input.author],
      );

      return mapArtifact(updated);
    });
  }

  static async history(threadId: string, idOrName: string): Promise<ChatArtifactRevision[]> {
    const artifact = await this.get(threadId, idOrName, true);
    if (!artifact) throw new Error(`Artifact "${ idOrName }" was not found in this chat.`);
    const rows = await postgresClient.query<ChatArtifactRevisionRow>(
      `SELECT artifact_id, version, content, author, created_at
         FROM chat_artifact_revisions WHERE artifact_id = $1
         ORDER BY version DESC`,
      [artifact.id],
    );

    return rows.map(mapRevision);
  }

  static async revision(threadId: string, idOrName: string, version: number): Promise<ChatArtifactRevision | null> {
    const artifact = await this.get(threadId, idOrName, true);
    if (!artifact) return null;
    const row = await postgresClient.queryOne<ChatArtifactRevisionRow>(
      `SELECT artifact_id, version, content, author, created_at
         FROM chat_artifact_revisions WHERE artifact_id = $1 AND version = $2`,
      [artifact.id, version],
    );

    return row ? mapRevision(row) : null;
  }
}

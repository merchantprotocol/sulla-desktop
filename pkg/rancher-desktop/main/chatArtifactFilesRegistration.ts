import path from 'node:path';

import { getSullaFilesWatcher } from './sullaFilesWatcher';

import type { ArtifactFilesRegistration, FilesRegistrationResult } from '@pkg/agent/services/ChatArtifactService';
import type { ChatArtifactKind, ChatArtifactRecord } from '@pkg/shared/chatArtifacts';

const AGENT_ID = 'sulla-desktop-artifacts';
const MAX_ATTEMPTS = 3;
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

class ArtifactFilesRegistrationError extends Error {
  constructor(message: string, readonly filesPath: string) { super(message) }
}

class ArtifactFilesPathConflictError extends ArtifactFilesRegistrationError {}

function safeSegment(value: string, fallback: string): string {
  const clean = value.normalize('NFKC').replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim();

  return (clean || fallback).slice(0, 160);
}

function extension(kind: ChatArtifactKind, language?: string | null): string {
  if (kind === 'markdown') return '.md';
  if (kind === 'html') return '.html';
  const byLanguage: Record<string, string> = {
    css: '.css', javascript: '.js', json: '.json', jsx: '.jsx', markdown: '.md',
    python: '.py', shell: '.sh', sql: '.sql', typescript: '.ts', tsx: '.tsx', yaml: '.yaml',
  };

  return byLanguage[String(language ?? '').toLowerCase()] ?? '.txt';
}

function artifactPath(artifact: ChatArtifactRecord): string {
  const ext = extension(artifact.kind, artifact.language);
  const name = safeSegment(path.basename(artifact.name), 'artifact');
  const fileName = path.extname(name) ? name : `${ name }${ ext }`;

  return `Sulla-made/artifacts/${ safeSegment(artifact.id, 'artifact') }/${ fileName }`;
}

function mime(artifact: ChatArtifactRecord): string {
  if (artifact.kind === 'html') return 'text/html; charset=utf-8';
  if (artifact.kind === 'markdown') return 'text/markdown; charset=utf-8';

  return 'text/plain; charset=utf-8';
}

async function responseError(response: Response): Promise<string> {
  const body = await response.json().catch(() => ({})) as { error?: unknown };

  return typeof body.error === 'string' && body.error ? body.error : `Sulla Files returned ${ response.status }`;
}

export class ChatArtifactFilesRegistration implements ArtifactFilesRegistration {
  async register(artifact: ChatArtifactRecord): Promise<FilesRegistrationResult> {
    const targetPath = artifact.filesPath || artifactPath(artifact);
    const recovered = await this.recoverAfterFailure(artifact, targetPath);
    if (recovered) return recovered;
    const input = {
      collectionId: artifact.filesCollectionId ?? undefined,
      fileId: artifact.filesFileId ?? undefined,
      path: targetPath,
      content: artifact.content,
      mime: mime(artifact),
      message: `Saved from chat artifact ${ artifact.id } v${ artifact.version }`,
      idempotencyKey: `artifact:${ artifact.id }:v${ artifact.version }`,
    };
    let lastError = 'Sulla Files registration failed';

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const response = await getSullaFilesWatcher().requestFiles('/v1/agent-files', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        }, false, { agentId: AGENT_ID, threadId: artifact.threadId });
        if (response.ok) {
          const result = await response.json() as Partial<FilesRegistrationResult>;
          if (!result.fileId || !result.versionId || !result.collectionId || !result.path) {
            throw new Error('Sulla Files returned an incomplete artifact reference');
          }
          return result as FilesRegistrationResult;
        }
        lastError = await responseError(response);
        const afterAmbiguousFailure = await this.recoverAfterFailure(artifact, targetPath);
        if (afterAmbiguousFailure) return afterAmbiguousFailure;
        if (!RETRYABLE_STATUSES.has(response.status)) break;
      } catch (error) {
        if (error instanceof ArtifactFilesPathConflictError) throw error;
        lastError = error instanceof Error ? error.message : String(error);
        const afterAmbiguousFailure = await this.recoverAfterFailure(artifact, targetPath);
        if (afterAmbiguousFailure) return afterAmbiguousFailure;
      }
      if (attempt < MAX_ATTEMPTS) await new Promise(resolve => setTimeout(resolve, attempt * 150));
    }
    throw new ArtifactFilesRegistrationError(lastError, targetPath);
  }

  private async recoverAfterFailure(artifact: ChatArtifactRecord, targetPath: string): Promise<FilesRegistrationResult | undefined> {
    try {
      return await this.recover(artifact, targetPath);
    } catch (error) {
      // A provenance or identity conflict is deterministic and must fail closed.
      // Connectivity failures still permit the authenticated write attempt.
      if (error instanceof ArtifactFilesPathConflictError) throw error;
      return undefined;
    }
  }

  private async recover(artifact: ChatArtifactRecord, targetPath: string): Promise<FilesRegistrationResult | undefined> {
    const watcher = getSullaFilesWatcher();
    const capability = { agentId: AGENT_ID, threadId: artifact.threadId };
    const collectionsResponse = await watcher.requestFiles('/v1/collections', {}, false, capability);
    if (!collectionsResponse.ok) return undefined;
    const collections = await collectionsResponse.json() as { id: string; created_at?: string }[];
    const candidates = artifact.filesCollectionId
      ? collections.filter(collection => collection.id === artifact.filesCollectionId)
      // /v1/agent-files chooses the owner's oldest native knowledge collection
      // when no collection is supplied. Recovery must inspect that same target,
      // not attach this artifact to a same-named file in another collection.
      : [...collections].sort((left, right) => {
        const leftTime = Date.parse(left.created_at ?? '');
        const rightTime = Date.parse(right.created_at ?? '');

        return (Number.isFinite(leftTime) ? leftTime : Number.MAX_SAFE_INTEGER) -
          (Number.isFinite(rightTime) ? rightTime : Number.MAX_SAFE_INTEGER);
      }).slice(0, 1);
    const parentPath = path.posix.dirname(targetPath);
    for (const collection of candidates) {
      const filesResponse = await watcher.requestFiles(`/v1/files?collectionId=${ encodeURIComponent(collection.id) }&path=${ encodeURIComponent(parentPath === '.' ? '' : parentPath) }&trash=false`, {}, false, capability);
      if (!filesResponse.ok) continue;
      const files = await filesResponse.json() as { id: string; path: string; current_version_id: string; created_by_type?: string; created_by_id?: string }[];
      const file = files.find(candidate => candidate.path === targetPath);
      if (!file) continue;
      if ((artifact.filesFileId && file.id !== artifact.filesFileId) || file.created_by_type !== 'agent-run' || file.created_by_id !== AGENT_ID) {
        throw new ArtifactFilesPathConflictError('Files already contains a different item at this artifact path. Nothing was overwritten.', targetPath);
      }
      const contentResponse = await watcher.requestFiles(`/v1/agent-files/${ encodeURIComponent(file.id) }`, {}, false, capability);
      if (!contentResponse.ok) continue;
      const content = await contentResponse.json() as { version?: { id?: string }; content_base64?: string };
      if (typeof content.content_base64 !== 'string' || Buffer.from(content.content_base64, 'base64').compare(Buffer.from(artifact.content, 'utf8')) !== 0) continue;
      return {
        fileId: file.id,
        versionId: content.version?.id || file.current_version_id,
        collectionId: collection.id,
        path: targetPath,
      };
    }
    return undefined;
  }
}

let instance: ChatArtifactFilesRegistration | undefined;
export function getChatArtifactFilesRegistration(): ChatArtifactFilesRegistration {
  instance ??= new ChatArtifactFilesRegistration();

  return instance;
}

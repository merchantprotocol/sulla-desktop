import path from 'node:path';

import { getSullaFilesWatcher } from './sullaFilesWatcher';

import type { ArtifactFilesRegistration, FilesRegistrationResult } from '@pkg/agent/services/ChatArtifactService';
import type { ChatArtifactKind, ChatArtifactRecord } from '@pkg/shared/chatArtifacts';

const AGENT_ID = 'sulla-desktop-artifacts';
const MAX_ATTEMPTS = 3;

class ArtifactFilesRegistrationError extends Error {
  constructor(message: string, readonly filesPath: string) { super(message) }
}

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
    const recovered = await this.recover(artifact, targetPath).catch(() => undefined);
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
        if (response.status !== 429) break;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        const afterAmbiguousFailure = await this.recover(artifact, targetPath).catch(() => undefined);
        if (afterAmbiguousFailure) return afterAmbiguousFailure;
        break;
      }
      if (attempt < MAX_ATTEMPTS) await new Promise(resolve => setTimeout(resolve, attempt * 150));
    }
    throw new ArtifactFilesRegistrationError(lastError, targetPath);
  }

  private async recover(artifact: ChatArtifactRecord, targetPath: string): Promise<FilesRegistrationResult | undefined> {
    const watcher = getSullaFilesWatcher();
    const capability = { agentId: AGENT_ID, threadId: artifact.threadId };
    const collectionsResponse = await watcher.requestFiles('/v1/collections', {}, false, capability);
    if (!collectionsResponse.ok) return undefined;
    const collections = await collectionsResponse.json() as { id: string }[];
    const candidates = artifact.filesCollectionId
      ? collections.filter(collection => collection.id === artifact.filesCollectionId)
      : collections;
    const parentPath = path.posix.dirname(targetPath);
    for (const collection of candidates) {
      const filesResponse = await watcher.requestFiles(`/v1/files?collectionId=${ encodeURIComponent(collection.id) }&path=${ encodeURIComponent(parentPath === '.' ? '' : parentPath) }&trash=false`, {}, false, capability);
      if (!filesResponse.ok) continue;
      const files = await filesResponse.json() as { id: string; path: string; current_version_id: string; created_by_type?: string; created_by_id?: string }[];
      const file = files.find(candidate => candidate.path === targetPath && candidate.created_by_type === 'agent-run' && candidate.created_by_id === AGENT_ID);
      if (!file || (artifact.filesFileId && file.id !== artifact.filesFileId)) continue;
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

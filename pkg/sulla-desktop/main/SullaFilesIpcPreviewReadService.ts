// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import path from 'node:path';

import { FilesApiError } from './sullaFilesClient';
import type { SullaFilesIpcApi, SullaFilesIpcRegistrar } from './SullaFilesIpcSupport';
import { isAgentWindowSender } from '@pkg/window/agentWindowTrust';

export type SullaFilesPreviewKind = 'html' | 'markdown' | 'code' | 'csv' | 'image' | 'pdf';

export interface SullaFilesPreviewDocument {
  id:string;
  path:string;
  name:string;
  mime:string;
  size:number;
  currentVersionId?:string;
}

export type SullaFilesPreviewReadResult =
  | { state:'ready'; kind:SullaFilesPreviewKind; document:SullaFilesPreviewDocument; content:string | Uint8Array; truncated:boolean }
  | { state:'metadata-only'; kind:'pdf'; document:SullaFilesPreviewDocument }
  | { state:'too-large'; kind:'image' | 'pdf'; document:SullaFilesPreviewDocument }
  | { state:'unsupported'; reason:'file-type' | 'binary-text'; document:SullaFilesPreviewDocument }
  | { state:'deleted'; document:SullaFilesPreviewDocument }
  | { state:'unavailable'; reason:'not-available' | 'authority-changed' | 'invalid-metadata' | 'invalid-content' }
  | { state:'offline' }
  | { state:'cancelled' };

export interface SullaFilesPreviewReadCaps {
  html:number;
  markdown:number;
  code:number;
  csv:number;
  image:number;
  pdf:number;
}

const DEFAULT_PREVIEW_CAPS:SullaFilesPreviewReadCaps = {
  html:     512 * 1024,
  markdown: 256 * 1024,
  code:     256 * 1024,
  csv:      256 * 1024,
  image:    2 * 1024 * 1024,
  pdf:      4 * 1024 * 1024,
};

interface NormalizedFile extends SullaFilesPreviewDocument {
  collectionId:string;
  deleted:boolean;
}

interface BoundedBody {
  bytes:Uint8Array;
  truncated:boolean;
  overflow:boolean;
}

const IMAGE_MIME = new Set(['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp']);
const IMAGE_EXTENSION = new Set(['.avif', '.gif', '.jpeg', '.jpg', '.png', '.webp']);
const STRUCTURED_TEXT_MIME = new Set(['application/json', 'application/ld+json', 'application/xml', 'application/x-yaml', 'application/yaml']);
const CODE_EXTENSION = new Set([
  '.c', '.cc', '.cpp', '.cs', '.css', '.go', '.h', '.hpp', '.ini', '.java', '.js', '.jsx', '.json', '.log',
  '.mjs', '.cjs', '.mdx', '.php', '.py', '.rb', '.rs', '.scss', '.sh', '.sql', '.swift', '.toml', '.ts', '.tsx',
  '.vue', '.xml', '.yaml', '.yml',
]);

/** Classifies only inert read representations; SVG and unknown/binary types stay non-previewable. */
export class SullaFilesPreviewContentClassifier {
  constructor(private readonly caps:SullaFilesPreviewReadCaps = DEFAULT_PREVIEW_CAPS) {}

  classify(file:SullaFilesPreviewDocument):{kind:SullaFilesPreviewKind;maxBytes:number} | undefined {
    const mime = file.mime.split(';', 1)[0].trim().toLowerCase();
    const extension = path.posix.extname(file.path).toLowerCase();
    const generic = mime === 'application/octet-stream' || mime === 'text/plain' || mime === '';

    if ((mime === 'text/html' && (extension === '.html' || extension === '.htm')) || (generic && (extension === '.html' || extension === '.htm'))) return { kind:'html', maxBytes:this.caps.html };
    if (mime === 'text/markdown' || mime === 'text/x-markdown' || (generic && ['.md', '.markdown'].includes(extension))) return { kind:'markdown', maxBytes:this.caps.markdown };
    if (mime === 'text/csv' || mime === 'application/csv' || mime === 'text/tab-separated-values' || (generic && ['.csv', '.tsv'].includes(extension))) return { kind:'csv', maxBytes:this.caps.csv };
    if ((mime === 'application/pdf' && extension === '.pdf') || (generic && extension === '.pdf')) return { kind:'pdf', maxBytes:this.caps.pdf };
    if (extension !== '.svg' && mime !== 'image/svg+xml' && (IMAGE_MIME.has(mime) || (generic && IMAGE_EXTENSION.has(extension)))) return { kind:'image', maxBytes:this.caps.image };

    if ((mime.startsWith('text/') && !['text/html', 'text/csv', 'text/markdown', 'text/x-markdown', 'text/tab-separated-values'].includes(mime))
      || STRUCTURED_TEXT_MIME.has(mime)
      || (generic && CODE_EXTENSION.has(extension))) return { kind:'code', maxBytes:this.caps.code };

    return undefined;
  }
}

/** Reads at most the caller-provided byte limit and cancels the upstream stream immediately at it. */
export class SullaFilesPreviewBoundedBodyReader {
  async read(response:Response, expectedSize:number, maxBytes:number, signal?:AbortSignal):Promise<BoundedBody | undefined> {
    const targetBytes = Math.min(expectedSize, maxBytes);
    if (!response.body || targetBytes <= 0) return targetBytes === 0 ? { bytes:new Uint8Array(), truncated:expectedSize > maxBytes, overflow:false } : undefined;

    const bytes = new Uint8Array(targetBytes);
    const reader = response.body.getReader();
    let offset = 0;
    let overflow = false;
    try {
      while (offset < targetBytes) {
        if (signal?.aborted) {
          await reader.cancel().catch(() => undefined);
          return undefined;
        }
        const part = await reader.read();
        if (part.done) break;
        const chunk = part.value;
        const count = Math.min(chunk.byteLength, targetBytes - offset);
        if (count) bytes.set(chunk.subarray(0, count), offset);
        offset += count;
        if (count < chunk.byteLength) overflow = true;
        if (offset === targetBytes) {
          // Metadata is pinned to a specific version. For oversized files, the cap is an intentional
          // prefix; for smaller files, any extra bytes mean the body did not match that version.
          await reader.cancel().catch(() => undefined);
          break;
        }
      }
    } catch {
      await reader.cancel().catch(() => undefined);
      return undefined;
    } finally {
      reader.releaseLock();
    }

    if (offset !== targetBytes) return undefined;
    return { bytes, truncated:expectedSize > maxBytes || overflow, overflow };
  }
}

/**
 * Main-process, memory-only preview reads. Each call resolves fresh metadata and body through the
 * existing Desktop Files client, which uses the trusted current Files principal and no agent
 * capability. The opaque principal snapshot prevents a result crossing an account/principal switch.
 */
export class SullaFilesIpcPreviewReadService {
  constructor(
    private readonly api:SullaFilesIpcApi,
    private readonly classifier = new SullaFilesPreviewContentClassifier(),
    private readonly bodyReader = new SullaFilesPreviewBoundedBodyReader(),
  ) {}

  async read(fileId:string, options:{signal?:AbortSignal} = {}):Promise<SullaFilesPreviewReadResult> {
    const id = typeof fileId === 'string' ? fileId.trim() : '';
    const signal = options.signal;
    if (!id || id.length > 200 || /[\u0000-\u001f]/.test(id)) return { state:'unavailable', reason:'invalid-metadata' };
    if (signal?.aborted) return { state:'cancelled' };

    let authorityBefore:string;
    try { authorityBefore = await this.api.client.currentAuthorityId(); }
    catch { return signal?.aborted ? { state:'cancelled' } : { state:'offline' }; }
    if (!authorityBefore) return { state:'offline' };

    let raw:unknown;
    try {
      const init:RequestInit = signal ? { signal } : {};
      raw = await this.api.client.json<unknown>(`/v1/files/${ encodeURIComponent(id) }`, init);
    } catch (error) {
      return this.failure(error, signal);
    }
    if (signal?.aborted) return { state:'cancelled' };
    const metadataAuthority = await this.authorityState(authorityBefore);
    if (metadataAuthority !== 'same') return metadataAuthority === 'offline' ? { state:'offline' } : { state:'unavailable', reason:'authority-changed' };

    const file = this.normalize(raw, id);
    if (!file) return { state:'unavailable', reason:'invalid-metadata' };
    if (file.deleted) return { state:'deleted', document:this.publicDocument(file) };
    if (!file.currentVersionId) return { state:'unavailable', reason:'invalid-metadata' };

    const preview = this.classifier.classify(file);
    if (!preview) return { state:'unsupported', reason:'file-type', document:this.publicDocument(file) };
    // PDFs are rendered by the renderer from metadata only in this epic. Never fetch PDF bytes.
    if (preview.kind === 'pdf') return { state:'metadata-only', kind:'pdf', document:this.publicDocument(file) };
    // Binary image previews must be complete; never issue a Range request or return a prefix.
    if (preview.kind === 'image' && file.size > preview.maxBytes) return { state:'too-large', kind:'image', document:this.publicDocument(file) };
    if (file.size === 0) {
      const content = preview.kind === 'image' || preview.kind === 'pdf' ? new Uint8Array() : '';
      return { state:'ready', kind:preview.kind, document:this.publicDocument(file), content, truncated:false };
    }

    if (signal?.aborted) return { state:'cancelled' };
    const textKind = preview.kind !== 'image' && preview.kind !== 'pdf';
    const rangeRequested = textKind && file.size > preview.maxBytes;
    const headers = rangeRequested ? { range:`bytes=0-${ preview.maxBytes - 1 }` } : undefined;
    const endpoint = `/v1/files/${ encodeURIComponent(id) }/preview?versionId=${ encodeURIComponent(file.currentVersionId) }`;
    let response:Response;
    try { response = await this.api.client.stream(endpoint, { method:'GET', ...(headers ? { headers } : {}) }, signal); }
    catch (error) { return this.failure(error, signal); }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return this.responseFailure(response.status);
    }
    if (response.status !== 200 && response.status !== 206) {
      await response.body?.cancel().catch(() => undefined);
      return { state:'unavailable', reason:'invalid-content' };
    }
    if (response.status === 206 && (!rangeRequested || !this.validContentRange(response.headers.get('content-range'), file.size, preview.maxBytes))) {
      await response.body?.cancel().catch(() => undefined);
      return { state:'unavailable', reason:'invalid-content' };
    }

    const bounded = await this.bodyReader.read(response, file.size, preview.maxBytes, signal);
    if (signal?.aborted) return { state:'cancelled' };
    if (!bounded || (bounded.overflow && file.size <= preview.maxBytes)) return { state:'unavailable', reason:'invalid-content' };
    const bodyAuthority = await this.authorityState(authorityBefore);
    if (bodyAuthority !== 'same') return bodyAuthority === 'offline' ? { state:'offline' } : { state:'unavailable', reason:'authority-changed' };

    if (textKind) {
      const text = this.decodeText(bounded.bytes, bounded.truncated);
      if (text === undefined || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return { state:'unsupported', reason:'binary-text', document:this.publicDocument(file) };
      return { state:'ready', kind:preview.kind, document:this.publicDocument(file), content:text, truncated:bounded.truncated };
    }

    return { state:'ready', kind:preview.kind, document:this.publicDocument(file), content:bounded.bytes, truncated:bounded.truncated };
  }

  register(ipc:SullaFilesIpcRegistrar):void {
    ipc.handle('sulla-files:preview-read', async (event, input:unknown) => {
      if (!isAgentWindowSender(event.sender) || event.senderFrame !== event.sender.mainFrame) throw new Error('Untrusted preview-read sender');
      if (!input || typeof input !== 'object' || Object.keys(input).length !== 1 || typeof (input as { fileId?:unknown }).fileId !== 'string') throw new Error('Invalid preview-read input');
      const fileId = (input as { fileId:string }).fileId;
      if (fileId.length > 200) throw new Error('Invalid preview-read input');
      return this.read(fileId);
    });
  }

  private normalize(value:unknown, requestedId:string):NormalizedFile | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const row = value as Record<string, unknown>;
    const id = typeof row.id === 'string' ? row.id : '';
    const filePath = typeof row.path === 'string' ? row.path : '';
    const deleted = (row.deleted_at !== undefined && row.deleted_at !== null) || row.deleted === true;
    const version = row.version && typeof row.version === 'object' ? row.version as Record<string, unknown> : undefined;
    const hasVersionSize = !!version && Object.prototype.hasOwnProperty.call(version, 'size');
    const rawSize = hasVersionSize ? version!.size : row.size;
    if (!(typeof rawSize === 'number' || typeof rawSize === 'string' && /^\d+$/.test(rawSize))) return undefined;
    const size = Number(rawSize);
    const collectionId = typeof row.collection_id === 'string' ? row.collection_id : '';
    const currentVersionId = typeof row.current_version_id === 'string' ? row.current_version_id : '';
    const versionId = typeof version?.id === 'string' ? version.id : '';
    if (id !== requestedId || !filePath || filePath.length > 4096 || !collectionId || !Number.isSafeInteger(size) || size < 0) return undefined;
    if (!deleted && (!currentVersionId || !versionId || versionId !== currentVersionId || !hasVersionSize)) return undefined;

    const document:SullaFilesPreviewDocument = {
      id,
      path:filePath,
      name:path.posix.basename(filePath),
      mime:typeof row.mime === 'string' && row.mime.trim() ? row.mime : 'application/octet-stream',
      size,
      ...(currentVersionId ? { currentVersionId } : {}),
    };
    return { ...document, collectionId, deleted };
  }

  private publicDocument(file:NormalizedFile):SullaFilesPreviewDocument {
    return {
      id:file.id,
      path:file.path,
      name:file.name,
      mime:file.mime,
      size:file.size,
      ...(file.currentVersionId ? { currentVersionId:file.currentVersionId } : {}),
    };
  }

  private validContentRange(value:string | null, size:number, maxBytes:number):boolean {
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value ?? '');
    if (!match) return false;
    const start = Number(match[1]);
    const end = Number(match[2]);
    const total = Number(match[3]);
    return start === 0 && total === size && end === Math.min(size - 1, maxBytes - 1);
  }

  private decodeText(bytes:Uint8Array, truncated:boolean):string | undefined {
    try {
      const decoder = new TextDecoder('utf-8', { fatal:true });
      const text = decoder.decode(bytes, { stream:truncated });
      return truncated ? text : text + decoder.decode();
    } catch { return undefined; }
  }

  private async authorityState(expected:string):Promise<'same' | 'changed' | 'offline'> {
    try {
      const actual = await this.api.client.currentAuthorityId();
      return actual ? actual === expected ? 'same' : 'changed' : 'offline';
    } catch { return 'offline'; }
  }

  private failure(error:unknown, signal?:AbortSignal):SullaFilesPreviewReadResult {
    if (signal?.aborted) return { state:'cancelled' };
    if (error instanceof FilesApiError && [401, 403, 404].includes(error.status)) return { state:'unavailable', reason:'not-available' };
    if (error instanceof FilesApiError && error.status >= 400 && error.status < 500) return { state:'unavailable', reason:'invalid-metadata' };
    return { state:'offline' };
  }

  private responseFailure(status:number):SullaFilesPreviewReadResult {
    if (status === 401 || status === 403 || status === 404) return { state:'unavailable', reason:'not-available' };
    if (status >= 400 && status < 500) return { state:'unavailable', reason:'invalid-content' };
    return { state:'offline' };
  }
}

// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * Files namespace v2 plaintext contract. These helpers run only after a client
 * opens a manifest. The Worker must never receive or call them with plaintext.
 */
export const NAMESPACE_VERSION = 2 as const;
export type NamespaceKind = 'file' | 'folder';
export type NamespaceOperation = 'create' | 'content' | 'metadata' | 'delete' | 'restore';
export type NamespaceChunk = [id: string, plainBytes: number];
export interface NamespaceManifest {
  v: 2;
  itemId: string;
  kind: NamespaceKind;
  name: string;
  parentFolderId: string | null;
  mime: string | null;
  size: number;
  mtime: number;
  sha256: string | null;
  chunks: NamespaceChunk[];
  deleted: boolean;
  parentVersionId: string | null;
  operation: NamespaceOperation;
  restoredFromVersionId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const own = (v: object, k: string) => Object.prototype.hasOwnProperty.call(v, k);

export function validateNamespaceManifest(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'namespace_object';
  const v = value as Record<string, unknown>;
  const required = ['v','itemId','kind','name','parentFolderId','mime','size','mtime','sha256','chunks','deleted','parentVersionId','operation'];
  const allowed = new Set([...required, 'restoredFromVersionId']);
  if (!required.every(k => own(v, k)) || Object.keys(v).some(k => !allowed.has(k))) return 'namespace_fields';
  if (v.v !== NAMESPACE_VERSION || typeof v.itemId !== 'string' || !UUID.test(v.itemId)) return 'namespace_identity';
  if (v.kind !== 'file' && v.kind !== 'folder') return 'namespace_kind';
  if (typeof v.name !== 'string' || !v.name.length || v.name.length > 1024 || /[\0/]/.test(v.name)) return 'namespace_name';
  if (v.parentFolderId !== null && (typeof v.parentFolderId !== 'string' || !UUID.test(v.parentFolderId) || v.parentFolderId === v.itemId)) return 'namespace_parent';
  if (v.parentVersionId !== null && (typeof v.parentVersionId !== 'string' || !UUID.test(v.parentVersionId))) return 'namespace_parent_version';
  if (v.mime !== null && (typeof v.mime !== 'string' || v.mime.length > 255)) return 'namespace_mime';
  if (!Number.isSafeInteger(v.size) || (v.size as number) < 0 || !Number.isSafeInteger(v.mtime) || (v.mtime as number) < 0) return 'namespace_numbers';
  if (v.sha256 !== null && (typeof v.sha256 !== 'string' || !HEX64.test(v.sha256))) return 'namespace_sha256';
  if (!Array.isArray(v.chunks) || v.chunks.length > 4096 || v.chunks.some(c => !Array.isArray(c) || c.length !== 2 || typeof c[0] !== 'string' || !HEX64.test(c[0]) || !Number.isSafeInteger(c[1]) || c[1] < 0)) return 'namespace_chunks';
  if (typeof v.deleted !== 'boolean' || !['create','content','metadata','delete','restore'].includes(String(v.operation))) return 'namespace_operation';
  if (v.kind === 'folder' && (v.size !== 0 || v.sha256 !== null || v.mime !== null || v.chunks.length !== 0)) return 'namespace_folder_payload';
  if (v.deleted && (v.operation !== 'delete' || v.size !== 0 || v.sha256 !== null || v.chunks.length !== 0)) return 'namespace_tombstone';
  if (!v.deleted && v.operation === 'delete') return 'namespace_tombstone';
  if (!v.deleted && v.kind === 'file' && v.chunks.reduce((total, chunk) => total + chunk[1], 0) !== v.size) return 'namespace_chunk_size';
  if (v.operation === 'restore') {
    if (typeof v.restoredFromVersionId !== 'string' || !UUID.test(v.restoredFromVersionId)) return 'namespace_restore_source';
  } else if (own(v, 'restoredFromVersionId')) return 'namespace_restore_source';
  if (v.operation === 'create' ? v.parentVersionId !== null : v.parentVersionId === null) return 'namespace_base_required';
  return null;
}

/** Enforces the stable identity and per-item CAS binding around an opened manifest. */
export function validateNamespaceCommitBinding(
  manifest: NamespaceManifest,
  commit: { fileId: string; versionId: string; baseVersionId: string | null; deleted: boolean; chunkIds: string[] },
): string | null {
  if (manifest.itemId !== commit.fileId) return 'namespace_item_id';
  if (manifest.parentVersionId !== commit.baseVersionId) return 'namespace_base_version';
  if (manifest.deleted !== commit.deleted) return 'namespace_deleted';
  if (manifest.chunks.length !== commit.chunkIds.length || manifest.chunks.some((c, i) => c[0] !== commit.chunkIds[i])) return 'namespace_chunk_binding';
  return null;
}

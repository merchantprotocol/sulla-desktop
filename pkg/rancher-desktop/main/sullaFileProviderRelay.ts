import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { sullaAppGroupDirectory } from './sullaAppGroup';

/**
 * Relay between SullaFileProvider.appex and the Files service.
 *
 * The sandboxed extension connects to a Unix socket inside the app-group
 * container. Every request carries the capability token main writes (0600)
 * next to the socket; main checks it before reading the body or touching
 * Files, then calls the Files HTTP API with its own Desktop authority. The
 * extension never holds Files credentials and never reaches the VM.
 *
 * Wire format, one request per connection:
 *   request:  u32be headerBytes · header JSON · body (header.bodyBytes)
 *   response: u32be headerBytes · header JSON · body until EOF (fetch only)
 */

export const RELAY_DIRECTORY = 'fp';
export const RELAY_SOCKET = 'relay.sock';
export const RELAY_TOKEN = 'token';
export const MAX_HEADER_BYTES = 64 * 1024;
export const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
const MAX_SOCKET_PATH_BYTES = 103;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[0-9a-f]{64}$/;
const SEQ = /^\d{1,19}$/;

export class RelayError extends Error {
  constructor(readonly status:number, message:string, readonly code?:string) { super(message) }
}

export function relayDirectory(home = os.homedir()):string {
  return path.join(sullaAppGroupDirectory(home), RELAY_DIRECTORY);
}

/** Short-lived bearer for the extension. The previous token stays valid until its own expiry so rotation never races a request. */
export class CapabilityTokens {
  private current:{ value:Buffer; expiresAt:number } | undefined;
  private previous:{ value:Buffer; expiresAt:number } | undefined;

  constructor(private readonly file:string, readonly ttlMs = 15 * 60_000, private readonly now:() => number = Date.now) {}

  async rotate():Promise<void> {
    const value = randomBytes(32);
    const temporary = `${ this.file }.${ randomUUID() }`;
    await fs.promises.writeFile(temporary, `${ value.toString('hex') }\n`, { mode: 0o600, flag: 'wx' });
    try { await fs.promises.rename(temporary, this.file) } catch (error) { await fs.promises.rm(temporary, { force: true }); throw error }
    this.previous = this.current;
    this.current = { value, expiresAt: this.now() + this.ttlMs };
  }

  verify(token:unknown):boolean {
    if (typeof token !== 'string' || !TOKEN.test(token)) return false;
    const presented = Buffer.from(token, 'hex');
    const now = this.now();
    let valid = false;
    for (const candidate of [this.current, this.previous]) {
      if (candidate && candidate.expiresAt > now && timingSafeEqual(candidate.value, presented)) valid = true;
    }
    return valid;
  }

  async revoke():Promise<void> {
    this.current = undefined; this.previous = undefined;
    await fs.promises.rm(this.file, { force: true });
  }
}

export type ParsedItemId =
  | { kind:'root' }
  | { kind:'trash' }
  | { kind:'collection'; collectionId:string }
  | { kind:'folder'; collectionId:string; folderId:string }
  | { kind:'path'; collectionId:string; path:string }
  | { kind:'file'; fileId:string };

const encodePath = (value:string) => Buffer.from(value, 'utf8').toString('base64url');

/** Mirrors the Files service path rules, plus macOS name limits. Rejects instead of normalizing. */
export function validateFilesPath(value:unknown):string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 4096) throw new RelayError(400, 'invalid Files path');
  for (const part of value.split('/')) {
    if (!part || part === '.' || part === '..' || part === '.sulla-trash' || part === '.sulla-operation-recovery' || Buffer.byteLength(part) > 255 || /[\0\\]/.test(part)) throw new RelayError(400, 'invalid Files path');
  }
  return value;
}

export function validateItemName(value:unknown):string {
  if (typeof value !== 'string' || value.includes('/')) throw new RelayError(400, 'invalid item name');
  return validateFilesPath(value);
}

export function parseItemId(value:unknown):ParsedItemId {
  if (typeof value !== 'string' || value.length > 8192) throw new RelayError(400, 'invalid item identifier');
  if (value === 'root') return { kind: 'root' };
  if (value === 'trash') return { kind: 'trash' };
  let match = /^c\.([0-9a-f-]{36})$/i.exec(value);
  if (match && UUID.test(match[1])) return { kind: 'collection', collectionId: match[1].toLowerCase() };
  match = /^f\.([0-9a-f-]{36})$/i.exec(value);
  if (match && UUID.test(match[1])) return { kind: 'file', fileId: match[1].toLowerCase() };
  match = /^d\.([0-9a-f-]{36})\.([0-9a-f-]{36})$/i.exec(value);
  if (match && UUID.test(match[1]) && UUID.test(match[2])) return { kind: 'folder', collectionId: match[1].toLowerCase(), folderId: match[2].toLowerCase() };
  match = /^p\.([0-9a-f-]{36})\.([A-Za-z0-9_-]+)$/i.exec(value);
  if (match && UUID.test(match[1])) {
    const decoded = Buffer.from(match[2], 'base64url').toString('utf8');
    if (encodePath(decoded) !== match[2]) throw new RelayError(400, 'invalid item identifier');
    return { kind: 'path', collectionId: match[1].toLowerCase(), path: validateFilesPath(decoded) };
  }
  throw new RelayError(400, 'invalid item identifier');
}

/** Change token = the Files journal seq of every visible collection. */
export function encodeChangeToken(seqs:Record<string, string>):string {
  return Buffer.from(JSON.stringify({ v: 1, c: seqs }), 'utf8').toString('base64url');
}

export function decodeChangeToken(value:unknown):Record<string, string> {
  const expired = () => new RelayError(410, 'change token expired', 'sync-anchor-expired');
  if (typeof value !== 'string' || value.length > 64 * 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) throw expired();
  let parsed:any;
  try { parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) } catch { throw expired() }
  if (!parsed || parsed.v !== 1 || !parsed.c || typeof parsed.c !== 'object' || Array.isArray(parsed.c)) throw expired();
  const entries = Object.entries(parsed.c);
  if (entries.length > 1000 || entries.some(([id, seq]) => !UUID.test(id) || typeof seq !== 'string' || !SEQ.test(seq))) throw expired();
  return Object.fromEntries(entries.map(([id, seq]) => [id.toLowerCase(), seq as string]));
}

export interface FileProviderItem {
  id:string; parentId:string; name:string; kind:'folder' | 'file';
  size?:number; contentVersion:string; metadataVersion:string;
  created?:string; modified?:string; mime?:string; keepOnComputer?:boolean;
}

export interface FileProviderFilesPort {
  json<T>(endpoint:string, init?:RequestInit):Promise<T>;
  request(endpoint:string, init?:RequestInit):Promise<Response>;
  stream(endpoint:string, signal?:AbortSignal):Promise<Response>;
}

export interface RelayHeader { v?:unknown; token?:unknown; op?:unknown; args?:unknown; bodyBytes?:unknown }
export interface RelayReply { result:unknown; body?:ReadableStream<Uint8Array> | null }

interface FolderRow { folderId:string; path:string; revision?:string }
const hash = (...parts:string[]) => createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32);
const parentOf = (value:string) => value.includes('/') ? value.slice(0, value.lastIndexOf('/')) : '';
const baseName = (value:string) => value.slice(value.lastIndexOf('/') + 1);
const iso = (value:unknown) => typeof value === 'string' && value ? value : undefined;
const enc = encodeURIComponent;
const OPS = new Set(['item', 'list', 'anchor', 'changes', 'fetch', 'create', 'modify', 'delete', 'pin']);
const BODY_OPS = new Set(['create', 'modify']);

/** Checks the token and the request shape. Nothing reaches Files unless this passes. */
export function authorizeRelayHeader(header:RelayHeader, tokens:CapabilityTokens):{ op:string; args:Record<string, unknown>; bodyBytes:number } {
  if (!header || typeof header !== 'object' || header.v !== 1) throw new RelayError(400, 'unsupported relay request');
  if (!tokens.verify(header.token)) throw new RelayError(401, 'capability token rejected', 'not-authenticated');
  if (typeof header.op !== 'string' || !OPS.has(header.op)) throw new RelayError(400, 'unsupported relay operation');
  const args = header.args ?? {};
  if (typeof args !== 'object' || Array.isArray(args)) throw new RelayError(400, 'relay arguments must be an object');
  const bodyBytes = header.bodyBytes ?? 0;
  if (typeof bodyBytes !== 'number' || !Number.isSafeInteger(bodyBytes) || bodyBytes < 0) throw new RelayError(400, 'invalid body length');
  if (bodyBytes > MAX_UPLOAD_BYTES) throw new RelayError(413, 'File is larger than the File Provider upload limit');
  if (bodyBytes > 0 && !BODY_OPS.has(header.op)) throw new RelayError(400, 'operation does not accept a body');
  return { op: header.op, args: args as Record<string, unknown>, bodyBytes };
}

export class FileProviderRelay {
  constructor(private readonly files:FileProviderFilesPort, private readonly tokens:CapabilityTokens, private readonly deviceName = os.hostname().split('.')[0] || 'Mac') {}

  async handle(header:RelayHeader, body:Buffer = Buffer.alloc(0)):Promise<RelayReply> {
    const { op, args } = authorizeRelayHeader(header, this.tokens);
    switch (op) {
    case 'item': return { result: await this.item(parseItemId(args.id)) };
    case 'list': return { result: { items: await this.list(parseItemId(args.id)) } };
    case 'anchor': return { result: { token: encodeChangeToken(await this.heads()) } };
    case 'changes': return { result: await this.changes(decodeChangeToken(args.token)) };
    case 'fetch': return this.fetch(parseItemId(args.id));
    case 'create': return { result: await this.create(parseItemId(args.parentId), validateItemName(args.name), args.kind, body) };
    case 'modify': return { result: await this.modify(parseItemId(args.id), args, body) };
    case 'delete': await this.remove(parseItemId(args.id), args.recursive === true); return { result: {} };
    case 'pin': return { result: await this.pin(parseItemId(args.id), args.keep) };
    }
    throw new RelayError(400, 'unsupported relay operation');
  }

  private async collections():Promise<Map<string, FileProviderItem>> {
    const rows = await this.files.json<any[]>('/v1/collections');
    const items = new Map<string, FileProviderItem>();
    const used = new Set<string>();
    // Logs and Training Data stay hidden in Finder, as they are in the File Manager.
    for (const row of rows.filter(row => typeof row?.id === 'string' && UUID.test(row.id) && row.systemArea !== 'logs' && row.systemArea !== 'training-data')) {
      const id = row.id.toLowerCase();
      let name = String(row.name ?? 'Collection').replace(/[/\0\\:]/g, '-').trim() || 'Collection';
      if (name === '.' || name === '..') name = 'Collection';
      if (used.has(name.toLowerCase())) name = `${ name } (${ id.slice(0, 8) })`;
      used.add(name.toLowerCase());
      items.set(id, { id: `c.${ id }`, parentId: 'root', name, kind: 'folder', contentVersion: 'folder', metadataVersion: hash(name, String(row.keep_on_computer === true)), modified: iso(row.updated_at), created: iso(row.created_at), keepOnComputer: row.keep_on_computer === true });
    }
    return items;
  }

  private async collection(collectionId:string):Promise<FileProviderItem> {
    const item = (await this.collections()).get(collectionId);
    if (!item) throw new RelayError(404, 'collection not found');
    return item;
  }

  private async folders(collectionId:string):Promise<Map<string, FolderRow>> {
    const rows = await this.files.json<FolderRow[]>(`/v1/folders?collectionId=${ enc(collectionId) }&details=true`);
    return new Map(rows.filter(row => typeof row?.path === 'string' && UUID.test(String(row.folderId))).map(row => [row.path, row]));
  }

  private folderItem(collectionId:string, folderPath:string, folders:Map<string, FolderRow>):FileProviderItem {
    const row = folders.get(folderPath);
    const parent = parentOf(folderPath);
    return {
      id:              row ? `d.${ collectionId }.${ row.folderId.toLowerCase() }` : `p.${ collectionId }.${ encodePath(folderPath) }`,
      parentId:        parent ? this.folderItem(collectionId, parent, folders).id : `c.${ collectionId }`,
      name:            baseName(folderPath),
      kind:            'folder',
      contentVersion:  'folder',
      metadataVersion: hash(folderPath, row?.revision ?? ''),
    };
  }

  private fileItem(row:any, folders:Map<string, FolderRow>):FileProviderItem {
    const collectionId = String(row.collection_id).toLowerCase();
    const parent = parentOf(row.path);
    return {
      id:              `f.${ String(row.id).toLowerCase() }`,
      parentId:        parent ? this.folderItem(collectionId, parent, folders).id : `c.${ collectionId }`,
      name:            baseName(row.path),
      kind:            'file',
      size:            Number(row.version?.size ?? row.visible_size ?? row.size ?? 0),
      contentVersion:  String(row.current_version_id),
      metadataVersion: hash(row.path, String(row.current_version_id)),
      created:         iso(row.created_at),
      modified:        iso(row.version_created_at) ?? iso(row.updated_at),
      mime:            typeof row.mime === 'string' ? row.mime : undefined,
    };
  }

  /** Resolves a container identifier to its collection and Files path. */
  private async container(id:ParsedItemId):Promise<{ collectionId:string; path:string; folders:Map<string, FolderRow> }> {
    if (id.kind === 'collection') { await this.collection(id.collectionId); return { collectionId: id.collectionId, path: '', folders: await this.folders(id.collectionId) } }
    if (id.kind === 'folder' || id.kind === 'path') {
      const folders = await this.folders(id.collectionId);
      const folderPath = id.kind === 'path' ? id.path : [...folders.values()].find(row => row.folderId.toLowerCase() === id.folderId)?.path;
      if (!folderPath) throw new RelayError(404, 'folder not found');
      return { collectionId: id.collectionId, path: folderPath, folders };
    }
    throw new RelayError(400, 'item is not a Files folder');
  }

  private async file(fileId:string):Promise<any> {
    const row = await this.files.json<any>(`/v1/files/${ enc(fileId) }`);
    if (!row || row.deleted_at || !row.current_version_id) throw new RelayError(404, 'file not found');
    return row;
  }

  private async item(id:ParsedItemId):Promise<FileProviderItem> {
    if (id.kind === 'root') return { id: 'root', parentId: 'root', name: 'Sulla', kind: 'folder', contentVersion: 'folder', metadataVersion: 'root' };
    if (id.kind === 'trash') throw new RelayError(404, 'trash is managed in Sulla Files');
    if (id.kind === 'collection') return this.collection(id.collectionId);
    if (id.kind === 'file') { const row = await this.file(id.fileId); return this.fileItem(row, await this.folders(row.collection_id)) }
    const resolved = await this.container(id);
    if (id.kind === 'path') {
      const files = await this.files.json<any[]>(`/v1/files?collectionId=${ enc(resolved.collectionId) }&path=${ enc(resolved.path) }&trash=false`);
      if (!resolved.folders.has(resolved.path) && !files.some(file => String(file.path).startsWith(`${ resolved.path }/`))) throw new RelayError(404, 'folder not found');
    }
    return this.folderItem(resolved.collectionId, resolved.path, resolved.folders);
  }

  private async list(id:ParsedItemId):Promise<FileProviderItem[]> {
    if (id.kind === 'root') return [...(await this.collections()).values()];
    if (id.kind === 'trash') return [];
    const { collectionId, path: folderPath, folders } = await this.container(id);
    const prefix = folderPath ? `${ folderPath }/` : '';
    const files = await this.files.json<any[]>(`/v1/files?collectionId=${ enc(collectionId) }&path=${ enc(folderPath) }&trash=false`);
    const items = new Map<string, FileProviderItem>();
    for (const folder of folders.keys()) {
      if (folder.startsWith(prefix) && folder.length > prefix.length && !folder.slice(prefix.length).includes('/')) { const item = this.folderItem(collectionId, folder, folders); items.set(item.id, item) }
    }
    for (const row of files) {
      if (typeof row?.path !== 'string' || !row.path.startsWith(prefix) || !row.current_version_id) continue;
      const rest = row.path.slice(prefix.length);
      const slash = rest.indexOf('/');
      const item = slash < 0 ? this.fileItem(row, folders) : this.folderItem(collectionId, prefix + rest.slice(0, slash), folders);
      items.set(item.id, item);
    }
    return [...items.values()];
  }

  private async head(collectionId:string):Promise<string> {
    const page = await this.files.json<{ seq:string }>(`/v1/collections/${ enc(collectionId) }/journal?after=0&changesOnly=true&head=true`);
    if (!SEQ.test(String(page?.seq))) throw new RelayError(502, 'Files returned an invalid journal head');
    return String(page.seq);
  }

  async heads():Promise<Record<string, string>> {
    const seqs:Record<string, string> = {};
    for (const collectionId of (await this.collections()).keys()) seqs[collectionId] = await this.head(collectionId);
    return seqs;
  }

  private async changes(since:Record<string, string>):Promise<{ updated:FileProviderItem[]; deleted:string[]; token:string; more:boolean }> {
    const collections = await this.collections();
    const updated = new Map<string, FileProviderItem>();
    const deleted = new Set<string>();
    const next:Record<string, string> = {};
    let more = false;
    for (const collectionId of Object.keys(since)) if (!collections.has(collectionId)) deleted.add(`c.${ collectionId }`);
    // Collection names and keep_on_computer pins are not journaled; resending them is cheap and idempotent.
    for (const item of collections.values()) updated.set(item.id, item);
    for (const collectionId of collections.keys()) {
      const after = since[collectionId];
      if (after === undefined) { next[collectionId] = await this.head(collectionId); continue }
      const page = await this.files.json<any[]>(`/v1/collections/${ enc(collectionId) }/journal?after=${ after }`);
      let seq = BigInt(after);
      const latest = new Map<string, any>();
      for (const entry of page) {
        if (SEQ.test(String(entry?.seq)) && BigInt(entry.seq) > seq) seq = BigInt(entry.seq);
        const fileId = String(entry?.file?.id ?? entry?.file_id ?? '').toLowerCase();
        if (UUID.test(fileId)) latest.set(fileId, entry);
      }
      const folders = latest.size ? await this.folders(collectionId) : new Map<string, FolderRow>();
      for (const [fileId, entry] of latest) {
        // Journal rows join the file's current row, so the newest state wins.
        if (entry.op === 'purge' || entry.file?.deleted_at || !entry.file?.current_version_id || typeof entry.file?.path !== 'string') { deleted.add(`f.${ fileId }`); updated.delete(`f.${ fileId }`); continue }
        const file = this.fileItem(entry.file, folders);
        updated.set(file.id, file);
        for (let parent = parentOf(entry.file.path); parent; parent = parentOf(parent)) { const folder = this.folderItem(collectionId, parent, folders); updated.set(folder.id, folder) }
      }
      if (page.length >= 1000) more = true;
      next[collectionId] = seq.toString();
    }
    return { updated: [...updated.values()], deleted: [...deleted], token: encodeChangeToken(next), more };
  }

  private async fetch(id:ParsedItemId):Promise<RelayReply> {
    if (id.kind !== 'file') throw new RelayError(400, 'only files have contents');
    const row = await this.file(id.fileId);
    const item = this.fileItem(row, await this.folders(row.collection_id));
    const response = await this.files.stream(`/v1/files/${ enc(id.fileId) }/download?versionId=${ enc(row.current_version_id) }`);
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new RelayError(response.status === 404 ? 404 : 502, `Files content request failed (${ response.status })`) }
    return { result: { item, bytes: Number(response.headers.get('content-length') ?? -1) }, body: response.body };
  }

  private async json<T>(endpoint:string, init:RequestInit, expected?:number[]):Promise<{ status:number; body:T }> {
    const response = await this.files.request(endpoint, init);
    const body = await response.json().catch(() => ({})) as T & { error?:string; code?:string };
    if (!response.ok && !expected?.includes(response.status)) throw new RelayError(response.status, body?.error ?? `Files request failed (${ response.status })`, body?.code);
    return { status: response.status, body };
  }

  private async importFile(collectionId:string, filePath:string, body:Buffer, mime = 'application/octet-stream'):Promise<any> {
    return (await this.json<any>(`/v1/files/import?collectionId=${ enc(collectionId) }&path=${ enc(filePath) }&conflict=keep-both`, { method: 'PUT', headers: { 'content-type': mime }, body: body as unknown as BodyInit })).body;
  }

  private async create(parentId:ParsedItemId, name:string, kind:unknown, body:Buffer):Promise<FileProviderItem> {
    if (parentId.kind === 'root') throw new RelayError(403, 'Create files inside a Files collection');
    const parent = await this.container(parentId);
    const target = parent.path ? `${ parent.path }/${ name }` : name;
    if (kind === 'folder') {
      if (body.length) throw new RelayError(400, 'folders have no contents');
      await this.json('/v1/folders', { method: 'POST', body: JSON.stringify({ collectionId: parent.collectionId, path: target }) });
      return this.folderItem(parent.collectionId, target, await this.folders(parent.collectionId));
    }
    if (kind !== 'file') throw new RelayError(422, 'Sulla Files stores files and folders only');
    const row = await this.importFile(parent.collectionId, target, body);
    return this.fileItem(await this.file(row.id), await this.folders(parent.collectionId));
  }

  private async batch(collectionId:string, item:Record<string, unknown>):Promise<void> {
    const submitted = (await this.json<{ operationId:string }>('/v1/database-file-operations', { method: 'POST', body: JSON.stringify({ idempotencyKey: randomUUID(), collectionId, items: [{ itemId: randomUUID(), ...item }] }) })).body;
    if (!UUID.test(String(submitted?.operationId))) throw new RelayError(502, 'Files did not return an operation id');
    for (let attempt = 0; attempt < 240; attempt++) {
      const state = await this.files.json<{ state:string; items?:{ error?:{ message?:string; status?:number } | null }[] }>(`/v1/database-file-operations/${ enc(submitted.operationId) }`);
      if (state.state === 'completed') return;
      if (state.state !== 'pending') throw new RelayError(state.items?.[0]?.error?.status ?? 409, state.items?.[0]?.error?.message ?? 'Files operation did not complete');
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new RelayError(504, 'Files operation is still running');
  }

  private conflictName(name:string):string {
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16).replace(':', '');
    const device = this.deviceName.replace(/[/\0\\:]/g, '-').slice(0, 40);
    const dot = name.lastIndexOf('.');
    const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    return `${ stem } (conflicted copy ${ device } ${ stamp })${ extension }`;
  }

  private async modify(id:ParsedItemId, args:Record<string, unknown>, body:Buffer):Promise<{ item:FileProviderItem; conflictCopy?:FileProviderItem }> {
    const name = args.name === undefined ? undefined : validateItemName(args.name);
    const parent = args.parentId === undefined ? undefined : await this.container(parseItemId(args.parentId));
    const contents = args.contents === true;
    if (id.kind === 'file') {
      let row = await this.file(id.fileId);
      if (name !== undefined || parent) {
        const targetCollection = parent?.collectionId ?? row.collection_id;
        const targetParent = parent ? parent.path : parentOf(row.path);
        const targetPath = validateFilesPath(targetParent ? `${ targetParent }/${ name ?? baseName(row.path) }` : name ?? baseName(row.path));
        if (targetPath !== row.path || targetCollection !== row.collection_id) {
          await this.batch(row.collection_id, { action: targetCollection === row.collection_id ? 'rename' : 'move', fileId: row.id, expectedVersionId: row.current_version_id, expectedRevision: String(row.operation_revision ?? '0'), targetPath, ...(targetCollection === row.collection_id ? {} : { targetCollectionId: targetCollection }) });
          row = await this.file(row.id);
        }
      }
      let conflictCopy:FileProviderItem | undefined;
      if (contents) {
        const base = typeof args.baseVersion === 'string' && UUID.test(args.baseVersion) ? args.baseVersion : '';
        if (!base) throw new RelayError(400, 'contents changes require the base Files version');
        const upload = await this.json<any>(`/v1/files/upload?collectionId=${ enc(row.collection_id) }&path=${ enc(row.path) }&baseVersionId=${ enc(base) }`, { method: 'PUT', headers: { 'content-type': row.mime || 'application/octet-stream' }, body: body as unknown as BodyInit }, [409]);
        if (upload.status === 409) {
          // Keep both: the remote version stays; this Mac's bytes become a sibling.
          const parentPath = parentOf(row.path);
          const copy = await this.importFile(row.collection_id, parentPath ? `${ parentPath }/${ this.conflictName(baseName(row.path)) }` : this.conflictName(baseName(row.path)), body, row.mime);
          conflictCopy = this.fileItem(await this.file(copy.id), await this.folders(row.collection_id));
        }
        row = await this.file(row.id);
      }
      return { item: this.fileItem(row, await this.folders(row.collection_id)), ...(conflictCopy ? { conflictCopy } : {}) };
    }
    if (contents || body.length) throw new RelayError(400, 'folders have no contents');
    const source = await this.container(id);
    if (!source.path) throw new RelayError(403, 'Rename collections in Sulla Files');
    if (name !== undefined || parent) {
      const targetCollection = parent?.collectionId ?? source.collectionId;
      const targetParent = parent ? parent.path : parentOf(source.path);
      const targetPath = validateFilesPath(targetParent ? `${ targetParent }/${ name ?? baseName(source.path) }` : name ?? baseName(source.path));
      if (targetPath === source.path && targetCollection === source.collectionId) return { item: this.folderItem(source.collectionId, source.path, source.folders) };
      if (targetPath.startsWith(`${ source.path }/`) && targetCollection === source.collectionId) throw new RelayError(400, 'a folder cannot move into itself');
      const state = await this.files.json<{ folderId?:string; subtreeSignature:string }>(`/v1/database-file-operations/folder-state?collectionId=${ enc(source.collectionId) }&path=${ enc(source.path) }`);
      await this.batch(source.collectionId, { kind: 'folder', action: targetCollection === source.collectionId ? 'rename' : 'move', folderPath: source.path, ...(state.folderId ? { expectedFolder: state } : {}), sourceSubtreeSignature: state.subtreeSignature, targetPath, ...(targetCollection === source.collectionId ? {} : { targetCollectionId: targetCollection }) });
      return { item: this.folderItem(targetCollection, targetPath, await this.folders(targetCollection)) };
    }
    return { item: this.folderItem(source.collectionId, source.path, source.folders) };
  }

  private async remove(id:ParsedItemId, recursive:boolean):Promise<void> {
    if (id.kind === 'file') { await this.file(id.fileId); await this.json(`/v1/files/${ enc(id.fileId) }`, { method: 'DELETE' }); return }
    if (id.kind !== 'folder' && id.kind !== 'path') throw new RelayError(403, 'Collections are removed in Sulla Files');
    const source = await this.container(id);
    const files = await this.files.json<any[]>(`/v1/files?collectionId=${ enc(source.collectionId) }&path=${ enc(source.path) }&trash=false`);
    const occupied = files.some(file => String(file.path).startsWith(`${ source.path }/`)) || [...source.folders.keys()].some(folder => folder.startsWith(`${ source.path }/`));
    if (occupied && !recursive) throw new RelayError(409, 'folder is not empty', 'directory-not-empty');
    const state = await this.files.json<{ folderId?:string; subtreeSignature:string }>(`/v1/database-file-operations/folder-state?collectionId=${ enc(source.collectionId) }&path=${ enc(source.path) }`);
    await this.batch(source.collectionId, { kind: 'folder', action: 'trash', folderPath: source.path, ...(state.folderId ? { expectedFolder: state } : {}), sourceSubtreeSignature: state.subtreeSignature });
  }

  /** Only a collection pin maps to Files (keep_on_computer); deeper pins stay system-managed on the Mac. */
  private async pin(id:ParsedItemId, keep:unknown):Promise<{ applied:boolean }> {
    if (typeof keep !== 'boolean') throw new RelayError(400, 'keep must be a boolean');
    if (id.kind !== 'collection') return { applied: false };
    await this.json(`/v1/collections/${ enc(id.collectionId) }/keep-on-computer`, { method: 'PATCH', body: JSON.stringify({ enabled: keep }) });
    return { applied: true };
  }
}

function frame(header:unknown):Buffer {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(json.length);
  return Buffer.concat([length, json]);
}

function errorReply(error:unknown):{ ok:false; status:number; error:string; code?:string } {
  if (error instanceof RelayError) return { ok: false, status: error.status, error: error.message, ...(error.code ? { code: error.code } : {}) };
  const status = Number((error as { status?:unknown })?.status);
  if (Number.isInteger(status) && status >= 400 && status < 500) return { ok: false, status, error: error instanceof Error ? error.message : 'Files rejected the request' };
  return { ok: false, status: 503, error: 'Sulla Files is unavailable' };
}

/** Reads one framed request. The token is checked as soon as the header arrives, before any body byte is buffered. */
export function readRelayRequest(socket:net.Socket, tokens:CapabilityTokens):Promise<{ header:RelayHeader; body:Buffer }> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    let header:RelayHeader | undefined;
    let expected = 0;
    const chunks:Buffer[] = [];
    let received = 0;
    const fail = (error:unknown) => { socket.off('data', onData); reject(error) };
    const finish = () => { socket.off('data', onData); resolve({ header: header!, body: Buffer.concat(chunks, received) }) };
    const onData = (chunk:Buffer) => {
      if (header) {
        chunks.push(chunk); received += chunk.length;
        if (received > expected) return fail(new RelayError(400, 'body longer than declared'));
        if (received === expected) finish();
        return;
      }
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < 4) return;
      const length = buffered.readUInt32BE(0);
      if (length < 2 || length > MAX_HEADER_BYTES) return fail(new RelayError(400, 'invalid relay header'));
      if (buffered.length < 4 + length) return;
      try { header = JSON.parse(buffered.subarray(4, 4 + length).toString('utf8')) as RelayHeader } catch { return fail(new RelayError(400, 'invalid relay header')) }
      try { expected = authorizeRelayHeader(header, tokens).bodyBytes } catch (error) { return fail(error) }
      const rest = buffered.subarray(4 + length);
      buffered = Buffer.alloc(0);
      if (rest.length) { chunks.push(rest); received = rest.length }
      if (received > expected) return fail(new RelayError(400, 'body longer than declared'));
      if (received === expected) finish();
    };
    socket.on('data', onData);
    socket.once('end', () => { if (!header || received < expected) fail(new RelayError(400, 'truncated relay request')) });
    socket.once('error', fail);
  });
}

export class FileProviderRelayServer {
  private server:net.Server | undefined;
  private rotation:ReturnType<typeof setInterval> | undefined;
  readonly directory:string;
  readonly socketPath:string;
  readonly tokens:CapabilityTokens;
  private readonly relay:FileProviderRelay;

  constructor(files:FileProviderFilesPort, directory = relayDirectory()) {
    this.directory = directory;
    this.socketPath = path.join(directory, RELAY_SOCKET);
    this.tokens = new CapabilityTokens(path.join(directory, RELAY_TOKEN));
    this.relay = new FileProviderRelay(files, this.tokens);
  }

  get relayForChanges():FileProviderRelay { return this.relay }

  async start():Promise<void> {
    if (this.server) return;
    if (Buffer.byteLength(this.socketPath) > MAX_SOCKET_PATH_BYTES) throw new Error('File Provider relay socket path is too long for macOS');
    await fs.promises.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.promises.chmod(this.directory, 0o700);
    const stale = await fs.promises.lstat(this.socketPath).catch(() => undefined);
    if (stale?.isSocket()) await fs.promises.rm(this.socketPath);
    else if (stale) throw new Error('File Provider relay path is occupied by a non-socket file');
    await this.tokens.rotate();
    const server = net.createServer(socket => { void this.serve(socket) });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(this.socketPath, () => { server.off('error', reject); resolve() }) });
    await fs.promises.chmod(this.socketPath, 0o600);
    this.server = server;
    this.rotation = setInterval(() => { this.tokens.rotate().catch(error => console.warn('[SullaFileProvider] token rotation failed:', error)) }, this.tokens.ttlMs / 2);
    this.rotation.unref();
  }

  async stop():Promise<void> {
    if (this.rotation) clearInterval(this.rotation);
    this.rotation = undefined;
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    await this.tokens.revoke();
    await fs.promises.rm(this.socketPath, { force: true });
  }

  private async serve(socket:net.Socket):Promise<void> {
    socket.setTimeout(10 * 60_000, () => socket.destroy());
    let replied = false;
    try {
      const { header, body } = await readRelayRequest(socket, this.tokens);
      const reply = await this.relay.handle(header, body);
      socket.write(frame({ ok: true, result: reply.result }));
      replied = true;
      if (reply.body) {
        const reader = reply.body.getReader();
        socket.once('close', () => { void reader.cancel().catch(() => undefined) });
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!socket.write(value)) await new Promise(resolve => socket.once('drain', resolve));
        }
      }
      socket.end();
    } catch (error) {
      if (!(error instanceof RelayError)) console.warn('[SullaFileProvider] relay request failed:', error);
      // After the reply header, a short body is the only honest signal left.
      if (replied) socket.destroy();
      else if (!socket.destroyed) socket.end(frame(errorReply(error)));
    }
  }
}

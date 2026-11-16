// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import path from 'node:path';

export const DEFAULT_IGNORES = ['.DS_Store', '._*', '*.tmp', '~$*', '.git/', 'node_modules/', '*.sulla-conflict-*', '.sulla-trash/'];
export const NATIVE_POLL_ACTIVE_MS = 250;
export const NATIVE_POLL_IDLE_MAX_MS = 2_000;
export const NATIVE_SOURCE_PAGE_SIZE = 500;
export const NATIVE_SOURCE_MAX_PAGES = 40;
export const UNLOCK_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 30_000, 60_000];

export interface SullaFilesStatus {
  state: 'synced' | 'syncing' | 'paused' | 'error' | 'conflict'; pendingFiles: number; pendingBytes?: number;
  processedBytes?: number; totalBytes?: number; estimatedSeconds?: number; lastError?: string; lastScanAt?: string;
  lastSyncAt?: string; serverConfigured: boolean; location?: 'local' | 'server' | 'cloud'; serverLabel?: string;
}
export interface SullaFilesRootStatus {
  id: string; name: string; collectionId: string; syncMode: 'local' | 'server'; paused: boolean; exclusions: string[];
  state: 'idle' | 'scanning' | 'syncing' | 'paused' | 'offline' | 'error' | 'detached'; pendingFiles: number;
  serverConfigured: boolean; lastError?: string; lastScanAt?: string; lastSyncAt?: string;
}
export interface NativeSourceFileResult { id:string; current_version_id:string; path:string; mime:string; size:number }
export interface RecentSullaFile {
  id:string; path:string; mime:string; size:number; updatedAt:string; conflict:boolean; durationSeconds?:number;
  syncState:'synced' | 'syncing' | 'error';
}
export interface SullaFilesCapabilityContext { agentId?:string; jobId?:string; threadId?:string }
export interface NativeSourceIngestInput {
  operationId:string; handle:string; sourceRevision:string; contentHash:string; name:string; mime?:string; bytes:Buffer;
  fileId?:string; baseVersionId?:string; filesPath?:string; collectionId?:string; internal?:boolean;
}

export function requestHeaders(initHeaders:HeadersInit | undefined, internal:Record<string, string>, defaults:Record<string, string> = {}):Headers {
  const headers = new Headers(initHeaders);
  for (const [name, value] of Object.entries(defaults)) if (!headers.has(name)) headers.set(name, value);
  for (const [name, value] of Object.entries(internal)) headers.set(name, value);
  return headers;
}

export function ignored(relativePath:string, patterns:string[]):boolean {
  const normalized = relativePath.split(path.sep).join('/'); const parts = normalized.split('/');
  return patterns.some(raw => {
    const pattern = raw.trim().replace(/^\//, '');
    if (!pattern || pattern.startsWith('#')) return false;
    if (pattern.endsWith('/')) return parts.slice(0, -1).includes(pattern.slice(0, -1));
    const expression = new RegExp(`^${ pattern.split('*').map(value => value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')).join('.*') }$`);
    return expression.test(normalized) || parts.some(part => expression.test(part));
  });
}

export function isSensitiveTrackedPath(relativePath:string):boolean {
  return relativePath.split(/[\\/]/).some(part => {
    const value = part.toLowerCase();
    return value.includes('wallet') || value === 'vault' || value === 'vaults';
  });
}

export function trackedMime(relativePath:string):string {
  const extension = path.extname(relativePath).toLowerCase();
  return ({ '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif', '.webp':'image/webp',
    '.pdf':'application/pdf', '.json':'application/json', '.md':'text/markdown', '.txt':'text/plain', '.csv':'text/csv',
    '.html':'text/html' } as Record<string, string>)[extension] ?? 'application/octet-stream';
}

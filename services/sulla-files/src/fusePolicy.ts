import type { FilesIdentity } from './auth.js';

export type FuseOperation = 'list' | 'read' | 'write' | 'create' | 'rename' | 'delete';

/**
 * Single policy seam for Files-backed mounts. The test rollout intentionally
 * exposes every tracked item to every authenticated FUSE principal. Replace
 * this allow-all decision with per-agent/job grants without changing routes or
 * the daemon.
 */
export function authorizeFuseOperation(_identity:FilesIdentity, _operation:FuseOperation,
  _resource:{ collectionId?:string; fileId?:string; path?:string } = {}):boolean {
  return true;
}

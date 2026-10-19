import crypto from 'node:crypto';
import * as path from 'node:path';

import {
  chmodGuestPath,
  createGuestRuntimeDirectory,
  GUEST_PROVIDER_FILES_ROOT,
  removeGuestPathAtomic,
  writeGuestFileAtomic,
} from './GuestRuntimeTransport';

import type {
  ProviderFileRef,
  ProviderFileRequest,
  ProviderFileTransport,
} from '../languagemodels/ProviderExecutionTransport';

export const CONTAINER_PROVIDER_FILES_PATH = '/run/sulla-provider-files';

export function assertWorkspacePath(root: string, candidate: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolved);

  if (path.isAbsolute(relative) || relative.split(path.sep).includes('..')) {
    throw new Error(`Container provider path escaped its bounded root: ${ candidate }`);
  }
  return resolved;
}

/**
 * Stores provider inputs in the Lima guest, outside the container-writable
 * workspace. The source directory is mounted read-only inside the container,
 * so a container cannot redirect a Desktop write by replacing a parent path
 * with a symlink. No host-home path is used as a Docker bind source.
 */
export class ContainerProviderFileTransport implements ProviderFileTransport {
  readonly bindMount:   string;
  private readonly storageRoot: string;

  constructor(storageParent = GUEST_PROVIDER_FILES_ROOT) {
    this.storageRoot = createGuestRuntimeDirectory(storageParent, 'container-');
    // The provider runs as a different UID. Allow traversal without directory
    // listing; the Docker bind remains read-only.
    chmodGuestPath(this.storageRoot, 0o711);
    this.bindMount = `${ this.storageRoot }:${ CONTAINER_PROVIDER_FILES_PATH }:ro`;
  }

  write(request: ProviderFileRequest): ProviderFileRef {
    const safeName = request.suggestedName.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 120) || 'provider-file';
    const name = `${ crypto.randomUUID() }-${ safeName }`;
    const storageTarget = assertWorkspacePath(this.storageRoot, path.join(this.storageRoot, name));
    const providerTarget = assertWorkspacePath(CONTAINER_PROVIDER_FILES_PATH, path.posix.join(CONTAINER_PROVIDER_FILES_PATH, name));
    const mode = ((request.mode ?? 0o600) & 0o700) | 0o044;
    writeGuestFileAtomic(storageTarget, request.data, mode);
    let disposed = false;

    return {
      path: providerTarget,
      dispose() {
        if (disposed) return;
        disposed = true;
        try { removeGuestPathAtomic(storageTarget) } catch { /* already removed */ }
      },
    };
  }

  dispose(): void {
    removeGuestPathAtomic(this.storageRoot);
  }
}

// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

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
 * Stores provider inputs in the Sulla guest, outside the container-writable
 * workspace. The source directory is mounted read-only inside the container,
 * so a container cannot redirect a Desktop write by replacing a parent path
 * with a symlink. No host-home path is used as a Docker bind source.
 */
export class ContainerProviderFileTransport implements ProviderFileTransport {
  readonly bindMount:   string;
  private readonly storageRoot: string;
  /** Content-addressed files live for the container lifecycle. This makes an
   * unchanged system prompt a zero-I/O cache hit on subsequent turns. */
  private readonly contentFiles = new Map<string, Promise<{ storageTarget: string; providerTarget: string }>>();

  private constructor(storageRoot: string) {
    this.storageRoot = storageRoot;
    this.bindMount = `${ this.storageRoot }:${ CONTAINER_PROVIDER_FILES_PATH }:ro`;
  }

  static async create(storageParent = GUEST_PROVIDER_FILES_ROOT): Promise<ContainerProviderFileTransport> {
    const storageRoot = await createGuestRuntimeDirectory(storageParent, 'container-');
    // The provider runs as a different UID. Allow traversal without directory
    // listing; the Docker bind remains read-only.
    await chmodGuestPath(storageRoot, 0o711);
    return new ContainerProviderFileTransport(storageRoot);
  }

  async write(request: ProviderFileRequest): Promise<ProviderFileRef> {
    const mode = ((request.mode ?? 0o600) & 0o700) | 0o044;
    // Only the system prompt repeats turn after turn; attachments and MCP
    // configs are one-off and keep their delete-on-dispose lifetime.
    if (request.purpose !== 'system-prompt') return this.writeOnce(request, mode);

    const digest = crypto.createHash('sha256').update(request.data).digest('hex');
    const cacheKey = `${ mode.toString(8) }:${ digest }`;
    let cached = this.contentFiles.get(cacheKey);
    if (!cached) {
      cached = (async() => {
        const { storageTarget, providerTarget } = this.targetsFor(`${ digest }-system-prompt.md`);
        await writeGuestFileAtomic(storageTarget, request.data, mode);
        return { storageTarget, providerTarget };
      })();
      this.contentFiles.set(cacheKey, cached);
      cached.catch(() => this.contentFiles.delete(cacheKey));
    }
    const file = await cached;
    // Cached prompts are immutable and owned by this transport; dispose() of
    // the transport wipes the bounded storage root when the lifecycle ends.
    return { path: file.providerTarget, dispose() {} };
  }

  private targetsFor(name: string): { storageTarget: string; providerTarget: string } {
    return {
      storageTarget:  assertWorkspacePath(this.storageRoot, path.join(this.storageRoot, name)),
      providerTarget: assertWorkspacePath(CONTAINER_PROVIDER_FILES_PATH, path.posix.join(CONTAINER_PROVIDER_FILES_PATH, name)),
    };
  }

  private async writeOnce(request: ProviderFileRequest, mode: number): Promise<ProviderFileRef> {
    const safeName = request.suggestedName.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 120) || 'provider-file';
    const { storageTarget, providerTarget } = this.targetsFor(`${ crypto.randomUUID() }-${ safeName }`);
    await writeGuestFileAtomic(storageTarget, request.data, mode);
    let disposed = false;

    return {
      path: providerTarget,
      dispose() {
        if (disposed) return;
        disposed = true;
        removeGuestPathAtomic(storageTarget).catch(() => { /* already removed */ });
      },
    };
  }

  async dispose(): Promise<void> {
    await removeGuestPathAtomic(this.storageRoot);
  }
}

import crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

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
 * Stores provider inputs outside the container-writable workspace. The source
 * directory is mounted read-only inside the container, so a container cannot
 * redirect a host write by replacing a parent path with a symlink.
 */
export class ContainerProviderFileTransport implements ProviderFileTransport {
  readonly bindMount:   string;
  private readonly storageRoot: string;

  constructor(storageParent: string) {
    fs.mkdirSync(storageParent, { recursive: true, mode: 0o700 });
    fs.chmodSync(storageParent, 0o700);
    this.storageRoot = fs.mkdtempSync(path.join(storageParent, 'container-'));
    fs.chmodSync(this.storageRoot, 0o700);
    this.bindMount = `${ this.storageRoot }:${ CONTAINER_PROVIDER_FILES_PATH }:ro`;
  }

  write(request: ProviderFileRequest): ProviderFileRef {
    const safeName = request.suggestedName.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 120) || 'provider-file';
    const name = `${ crypto.randomUUID() }-${ safeName }`;
    const storageTarget = assertWorkspacePath(this.storageRoot, path.join(this.storageRoot, name));
    const providerTarget = assertWorkspacePath(CONTAINER_PROVIDER_FILES_PATH, path.posix.join(CONTAINER_PROVIDER_FILES_PATH, name));
    const fd = fs.openSync(
      storageTarget,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0),
      request.mode ?? 0o600,
    );
    try {
      fs.writeFileSync(fd, request.data);
    } finally {
      fs.closeSync(fd);
    }
    let disposed = false;

    return {
      path: providerTarget,
      dispose() {
        if (disposed) return;
        disposed = true;
        try { fs.unlinkSync(storageTarget) } catch { /* already removed */ }
      },
    };
  }

  dispose(): void {
    fs.rmSync(this.storageRoot, { recursive: true, force: true });
  }
}

import fs from 'fs';
import os from 'os';
import path from 'path';

import paths from '@pkg/utils/paths';

export interface SullaRuntimeArtifacts {
  /** The signed host binary (`sulla-runtime`). */
  binary: string;
  kernel: string;
  initrd: string;
}

/**
 * Runtime state directory shared with the host binary. The binary reads the
 * same SULLA_RUNTIME_DIR override, so both sides agree on the socket paths.
 */
export function sullaRuntimeDirectory(): string {
  return process.env.SULLA_RUNTIME_DIR ||
    path.join(os.homedir(), 'Library', 'Application Support', 'Sulla', 'runtime');
}

export const sullaRuntimeSockets = {
  get docker() {
    return path.join(sullaRuntimeDirectory(), 'docker.sock');
  },
  get control() {
    return path.join(sullaRuntimeDirectory(), 'control.sock');
  },
  get guest() {
    return path.join(sullaRuntimeDirectory(), 'guest.sock');
  },
};

async function requireFile(file: string, executable = false): Promise<string> {
  try {
    await fs.promises.access(file, executable ? fs.constants.X_OK : fs.constants.R_OK);
  } catch {
    throw new Error(`missing ${ file }`);
  }

  return file;
}

/**
 * Locate the host binary and guest boot files. Packaged builds carry them in
 * resources/darwin/sulla-runtime/; SULLA_RUNTIME_BIN and
 * SULLA_RUNTIME_GUEST_DIR point a dev build at local ones. Throws naming the
 * first missing file.
 */
export async function findSullaRuntimeArtifacts(): Promise<SullaRuntimeArtifacts> {
  const root = path.join(paths.resources, 'darwin', 'sulla-runtime');
  const guestDir = process.env.SULLA_RUNTIME_GUEST_DIR || path.join(root, 'guest');

  return {
    binary: await requireFile(process.env.SULLA_RUNTIME_BIN || path.join(root, 'sulla-runtime'), true),
    kernel: await requireFile(path.join(guestDir, 'vmlinuz')),
    initrd: await requireFile(path.join(guestDir, 'initramfs.img')),
  };
}

/**
 * Create (or repoint) the `limactl` symlink to the host binary in a
 * Desktop-owned directory. Invoked under that name, the binary answers
 * `limactl shell/copy/list` from the runtime, so every existing
 * `paths.limactl` call site keeps working.
 */
export async function ensureLimactlShim(binary: string): Promise<string> {
  const binDir = path.join(paths.appHome, 'sulla-runtime', 'bin');
  const shim = path.join(binDir, 'limactl');

  await fs.promises.mkdir(binDir, { recursive: true, mode: 0o700 });
  const current = await fs.promises.readlink(shim).catch(() => undefined);

  if (current !== binary) {
    await fs.promises.rm(shim, { force: true });
    await fs.promises.symlink(binary, shim);
  }

  return shim;
}

// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'fs';
import os from 'os';
import path from 'path';

import paths from '@pkg/utils/paths';

export interface SullaRuntimeArtifacts {
  /** The signed host binary (`sulla-runtime`). */
  binary: string;
  kernel: string;
  initrd: string;
  /** Read-only erofs image the guest mounts at /usr (Docker, tools, kernel modules). */
  usrImage: string;
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
    usrImage: await requireFile(path.join(guestDir, 'usr.erofs')),
  };
}

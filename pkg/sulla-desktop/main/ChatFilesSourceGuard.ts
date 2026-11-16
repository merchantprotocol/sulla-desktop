// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'node:fs';
import path from 'node:path';

export interface PreparedChatFilesSource {
  handle:  fs.promises.FileHandle;
  name:    string;
  size:    number;
  mtimeMs: number;
  dev:     number;
  ino:     number;
}

interface PathIdentity {
  path: string;
  dev:  number;
  ino:  number;
}

/**
 * Opens a host file chosen for a chat import without following a swapped path,
 * refuses protected application or secret material, and pins the file identity
 * so an upload can detect a source that changed underneath it.
 */
export class ChatFilesSourceGuard {
  static readonly maxImportBytes = 2 * 1024 * 1024 * 1024;
  private static readonly sensitiveParts:ReadonlySet<string> = new Set([
    '.aws', '.azure', '.gnupg', '.keychain', '.password-store', '.ssh', 'gcloud', 'keychains',
    'crypto-wallet', 'private-files-quarantine', 'vault', 'wallet', 'wallets',
  ]);

  /** `protectedRoots` is read per call: application paths are resolved after startup. */
  constructor(
    private readonly protectedRoots:() => (string | undefined)[],
    private readonly maxBytes = ChatFilesSourceGuard.maxImportBytes,
  ) {}

  assertImportable(source:string):void {
    const absolute = path.resolve(source);
    if (this.protectedRoots().some(root => root && this.isWithin(root, absolute))) throw new Error('That protected application file cannot be imported.');

    const parts = absolute.split(path.sep).filter(Boolean).map(part => part.toLocaleLowerCase());
    if (parts.some(part => ChatFilesSourceGuard.sensitiveParts.has(part) || part.includes('wallet') || part.includes('vault'))) throw new Error('That protected source cannot be imported.');
    const leaf = parts.at(-1) ?? '';
    if (leaf === '.env' || leaf.startsWith('.env.') || leaf === 'master.key' || /\.(?:key|pem|p12|pfx|seed|wallet)$/i.test(leaf)) {
      throw new Error('That protected source cannot be imported.');
    }
  }

  async prepare(source:string):Promise<PreparedChatFilesSource> {
    this.assertImportable(source);
    let resolved:string;
    try {
      resolved = await fs.promises.realpath(source);
    } catch {
      throw new Error('The selected source is no longer available.');
    }
    this.assertImportable(resolved);
    let before:fs.Stats;
    let handle:fs.promises.FileHandle | undefined;
    try {
      const ancestry = await this.pathAncestry(resolved);
      before = await fs.promises.lstat(resolved);
      const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
      handle = await fs.promises.open(resolved, flags);
      await this.assertSameAncestry(ancestry);
    } catch {
      await handle?.close().catch(() => undefined);
      throw new Error('The selected source could not be opened safely.');
    }
    try {
      const info = await handle.stat();
      if (!before.isFile() || !info.isFile() || before.dev !== info.dev || before.ino !== info.ino) throw new Error('The selected source changed before Files could open it.');
      if (!Number.isSafeInteger(info.size) || info.size < 0 || info.size > this.maxBytes) throw new Error('This file is too large to import into Files.');
      return { handle, name: path.basename(resolved), size: info.size, mtimeMs: info.mtimeMs, dev: info.dev, ino: info.ino };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  matches(source:PreparedChatFilesSource, info:fs.Stats):boolean {
    return info.isFile() && info.dev === source.dev && info.ino === source.ino && info.size === source.size && info.mtimeMs === source.mtimeMs;
  }

  private isWithin(root:string, candidate:string):boolean {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return relative === '' || (!relative.startsWith(`..${ path.sep }`) && relative !== '..' && !path.isAbsolute(relative));
  }

  private async pathAncestry(source:string):Promise<PathIdentity[]> {
    const identities:PathIdentity[] = [];
    let current = path.parse(source).root;
    for (const part of source.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      const info = await fs.promises.lstat(current);
      identities.push({ path: current, dev: info.dev, ino: info.ino });
    }
    return identities;
  }

  private async assertSameAncestry(identities:PathIdentity[]):Promise<void> {
    for (const identity of identities) {
      const current = await fs.promises.lstat(identity.path);
      if (current.dev !== identity.dev || current.ino !== identity.ino) throw new Error('The selected source path changed while Files was opening it.');
    }
  }
}

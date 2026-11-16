// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Characterization of the path-safety checks in FilesMutationCoordinator. Written before the
// class was split (W3-C) so the split is proven not to loosen any check. Linux-only: the
// coordinator pins parents through /proc/self/fd. Renames need the native no-replace helper,
// so rename specs skip when /usr/local/bin/sulla-files-rename-noreplace is absent.
import { existsSync } from 'node:fs';
import { link, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FilesMutationCoordinator } from '../src/safeFilesystem.js';

const linux = process.platform === 'linux';
const accept = async() => undefined;

describe.skipIf(!linux)('FilesMutationCoordinator path safety (characterization)', () => {
  let base = '';
  let root = '';
  let outside = '';
  let coordinator:FilesMutationCoordinator;

  beforeEach(async() => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'sulla-safe-fs-')));
    root = join(base, 'root');
    outside = join(base, 'outside');
    await mkdir(root); await mkdir(outside);
    await writeFile(join(outside, 'secret.txt'), 'outside secret');
    coordinator = new FilesMutationCoordinator(root);
    vi.spyOn(FilesMutationCoordinator, 'requireAtomicRename').mockResolvedValue(undefined);
  });
  afterEach(async() => {
    vi.restoreAllMocks();
    await rm(base, { recursive: true, force: true });
  });

  describe('traversal and absolute paths', () => {
    // risk: security — a ".." segment must never reach a file outside the Files root.
    it.each(['..', '../outside/secret.txt', 'a/../../outside/secret.txt', 'docs/..', './a.txt', 'a//b.txt', '..\\outside\\secret.txt'])(
      'refuses %s before touching the filesystem', async(path) => {
        await expect(coordinator.exists(path)).rejects.toThrow(/Invalid Files mutation path/);
        await expect(coordinator.pin(path)).rejects.toThrow(/Invalid Files mutation path/);
      },
    );

    // risk: security — absolute paths would bypass the root entirely.
    it.each(['/etc/passwd', '/', ''])('refuses absolute or empty path %j', async(path) => {
      await expect(coordinator.exists(path)).rejects.toThrow(/must be relative/);
    });

    // risk: security — an absolute path that happens to point inside the root is still refused.
    it('refuses an absolute path even when it is inside the root', async() => {
      await writeFile(join(root, 'inside.txt'), 'x');
      await expect(coordinator.pin(join(root, 'inside.txt'))).rejects.toThrow(/must be relative/);
    });

    // risk: data accuracy — leading/trailing slashes and backslashes normalise to the same file.
    it('normalises surrounding slashes and backslash separators to a root-relative path', async() => {
      await mkdir(join(root, 'docs'));
      await writeFile(join(root, 'docs', 'a.txt'), 'abc');
      const pinned = await coordinator.pin('docs\\a.txt');
      try { expect(pinned.relativePath).toBe('docs/a.txt') } finally { await pinned.close() }
      expect(await coordinator.exists('docs/a.txt/')).toBe(true);
    });
  });

  describe('symlink escape', () => {
    // risk: security — a symlinked directory inside the root must not expose files outside it.
    it('refuses a file reached through a symlinked parent directory', async() => {
      await symlink(outside, join(root, 'escape'));
      await expect(coordinator.pin('escape/secret.txt')).rejects.toThrow(/not a stable directory under root/);
      await expect(coordinator.exists('escape/secret.txt')).rejects.toThrow();
    });

    // risk: security — the final component is opened O_NOFOLLOW, so a symlinked file is refused.
    it('refuses a symlinked file even when its target is outside the root', async() => {
      await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'));
      await expect(coordinator.pin('link.txt')).rejects.toMatchObject({ code: 'ELOOP' });
    });

    // risk: security — a symlink that stays inside the root is still not a regular file.
    it('refuses a symlinked file whose target is inside the root', async() => {
      await writeFile(join(root, 'real.txt'), 'inside');
      await symlink(join(root, 'real.txt'), join(root, 'alias.txt'));
      await expect(coordinator.pin('alias.txt')).rejects.toMatchObject({ code: 'ELOOP' });
    });

    // risk: security — a nested symlink in an intermediate directory is caught by the realpath check.
    it('refuses a symlink in a deeper parent component', async() => {
      await mkdir(join(root, 'a'));
      await symlink(outside, join(root, 'a', 'b'));
      await expect(coordinator.pin('a/b/secret.txt')).rejects.toThrow(/not a stable directory under root/);
    });

    // risk: security — mkdir-parents must not walk through a symlink planted mid-path.
    it('will not create private staging through a symlinked namespace directory', async() => {
      await mkdir(join(root, '.sulla-trash'));
      await symlink(outside, join(root, '.sulla-trash', '.residency'));
      await expect(coordinator.openPrivateExclusive('.sulla-trash/.residency/x.stage')).rejects.toThrow();
      await expect(stat(join(outside, 'x.stage'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    // risk: security — folder enumeration refuses symlinks rather than following them.
    it('inspectTree refuses a folder that contains a symlink', async() => {
      await mkdir(join(root, 'tree'));
      await writeFile(join(root, 'tree', 'a.txt'), 'a');
      await symlink(join(outside, 'secret.txt'), join(root, 'tree', 'link'));
      await expect(coordinator.inspectTree('tree')).rejects.toThrow(/unsupported filesystem entry/);
    });

    // risk: data loss — a protected path anywhere in the tree stops the whole operation.
    it('inspectTree enumerates regular trees and stops at a protected path', async() => {
      await mkdir(join(root, 'tree', 'sub'), { recursive: true });
      await writeFile(join(root, 'tree', 'b.txt'), 'b');
      await writeFile(join(root, 'tree', 'sub', 'a.txt'), 'a');
      expect(await coordinator.inspectTree('tree')).toEqual({ directories: ['tree', 'tree/sub'], files: ['tree/b.txt', 'tree/sub/a.txt'] });
      await expect(coordinator.inspectTree('tree', path => !path.endsWith('a.txt'))).rejects.toThrow(/protected path/);
    });
  });

  describe('case and Unicode names', () => {
    // risk: data accuracy — names are byte-exact; no case folding merges two different files.
    it('treats names case-sensitively', async() => {
      await writeFile(join(root, 'Report.txt'), 'upper');
      expect(await coordinator.exists('Report.txt')).toBe(true);
      expect(await coordinator.exists('report.txt')).toBe(false);
    });

    // risk: data accuracy — no Unicode normalisation: NFC and NFD spellings stay distinct entries.
    it('does not normalise Unicode spellings', async() => {
      const nfc = 'café.txt';
      await writeFile(join(root, nfc), 'nfc');
      const pinned = await coordinator.pin(nfc);
      try { expect(pinned.relativePath).toBe(nfc) } finally { await pinned.close() }
      expect(await coordinator.exists(nfc.normalize('NFD'))).toBe(false);
    });

    // risk: security — look-alike dots are ordinary names that stay inside the root.
    it('treats fullwidth and one-dot-leader look-alikes of ".." as ordinary names inside the root', async() => {
      for (const name of ['．．', '‥']) {
        await mkdir(join(root, name));
        await writeFile(join(root, name, 'x.txt'), name);
        const pinned = await coordinator.pin(`${ name }/x.txt`);
        try { expect(pinned.relativePath).toBe(`${ name }/x.txt`) } finally { await pinned.close() }
      }
    });
  });

  describe('regular files only and pinned identity', () => {
    // risk: data loss — a directory is never treated as a mutation target file.
    it('refuses to pin a directory', async() => {
      await mkdir(join(root, 'folder'));
      await expect(coordinator.pin('folder')).rejects.toThrow(/must be a regular file/);
    });

    // risk: data accuracy — a write after pinning is detected before the operation commits.
    it('detects a change to a pinned file', async() => {
      await writeFile(join(root, 'p.txt'), 'one');
      const pinned = await coordinator.pin('p.txt');
      try {
        await pinned.assertUnchanged();
        await writeFile(join(root, 'p.txt'), 'two and more');
        await expect(pinned.assertUnchanged()).rejects.toThrow(/changed during operation/);
      } finally { await pinned.close() }
    });

    // risk: data accuracy — pinVerified closes and rethrows when verification fails.
    it('pinVerified surfaces the verifier rejection', async() => {
      await writeFile(join(root, 'v.txt'), 'v');
      await expect(coordinator.pinVerified('v.txt', async() => { throw new Error('bad bytes') })).rejects.toThrow('bad bytes');
    });
  });

  describe('private staging namespace', () => {
    // risk: security — staging is confined to the owned recovery namespaces.
    it.each(['docs/x.stage', '.sulla-trash/x.stage', '.sulla-trash/.other/x.stage'])('refuses private staging at %s', async(path) => {
      await expect(coordinator.openPrivateExclusive(path)).rejects.toThrow(/owned Files recovery namespace/);
    });

    // risk: data loss — exclusive create never truncates an existing stage; mode is owner-only.
    it('creates stages owner-only and exclusively', async() => {
      const handle = await coordinator.openPrivateExclusive('.sulla-trash/.residency/a.stage');
      await handle.close();
      expect((await stat(join(root, '.sulla-trash/.residency/a.stage'))).mode & 0o777).toBe(0o600);
      await expect(coordinator.openPrivateExclusive('.sulla-trash/.residency/a.stage')).rejects.toMatchObject({ code: 'EEXIST' });
    });
  });

  describe('no-clobber publication', () => {
    async function stage(name:string, body:string):Promise<string> {
      const path = `.sulla-trash/.residency/${ name }`;
      const handle = await coordinator.openPrivateExclusive(path);
      await handle.write(Buffer.from(body)); await handle.sync(); await handle.close();
      return path;
    }

    // risk: data loss — publication never overwrites an existing user file.
    it('refuses to publish over an existing target and leaves it intact', async() => {
      await writeFile(join(root, 'target.txt'), 'user edit');
      const staged = await stage('p.stage', 'incoming');
      await expect(coordinator.publishVerified({ staged, target: 'target.txt', verify: accept })).rejects.toThrow(/will not overwrite/);
      expect(await readFile(join(root, 'target.txt'), 'utf8')).toBe('user edit');
    });

    // risk: data accuracy — a successful publication links the exact staged inode.
    it('publishes a stage as a hard link of the same inode and finalizes the stage', async() => {
      const staged = await stage('q.stage', 'incoming');
      const receipt = await coordinator.publishVerified({ staged, target: 'new/q.txt', verify: accept });
      expect(await readFile(join(root, 'new/q.txt'), 'utf8')).toBe('incoming');
      expect((await stat(join(root, 'new/q.txt'))).ino).toBe((await stat(join(root, staged))).ino);
      await coordinator.finalizePublication(receipt);
      expect(await coordinator.exists(staged)).toBe(false);
      expect(await readFile(join(root, 'new/q.txt'), 'utf8')).toBe('incoming');
    });

    // risk: data loss — cleanup refuses to unlink a stage that was replaced after the receipt.
    it('finalizePublication preserves a replaced stage', async() => {
      const staged = await stage('r.stage', 'incoming');
      const receipt = await coordinator.publishVerified({ staged, target: 'r.txt', verify: accept });
      await rm(join(root, staged));
      await writeFile(join(root, staged), 'someone else');
      await expect(coordinator.finalizePublication(receipt)).rejects.toThrow(/identity changed/);
      expect(await readFile(join(root, staged), 'utf8')).toBe('someone else');
    });

    // risk: data loss — eviction refuses an occupied quarantine before moving the source.
    it('refuses to evict into an occupied quarantine', async() => {
      await writeFile(join(root, 'src.txt'), 'source');
      await mkdir(join(root, '.sulla-trash/.residency'), { recursive: true });
      await writeFile(join(root, '.sulla-trash/.residency/q.evict'), 'occupied');
      await expect(coordinator.evictVerified({ source: 'src.txt', quarantine: '.sulla-trash/.residency/q.evict', verify: accept }))
        .rejects.toThrow(/quarantine already exists/);
      expect(await readFile(join(root, 'src.txt'), 'utf8')).toBe('source');
    });

    // risk: data loss — a retained file is only disposed when it is still the proven inode.
    it('disposeRetainedFile preserves a file whose identity changed', async() => {
      await writeFile(join(root, 'kept.txt'), 'kept');
      const pinned = await coordinator.pin('kept.txt');
      const proven = pinned.fingerprint; await pinned.close();
      await rm(join(root, 'kept.txt')); await writeFile(join(root, 'kept.txt'), 'replacement');
      await expect(coordinator.disposeRetainedFile('kept.txt', proven, accept)).rejects.toThrow(/identity changed; preserved/);
      expect(await readFile(join(root, 'kept.txt'), 'utf8')).toBe('replacement');
    });

    // risk: data loss — a directory that gained children is never removed.
    it('disposeRetainedDirectory refuses a directory that acquired children', async() => {
      const receipt = await coordinator.createDirectory('d');
      await writeFile(join(root, 'd', 'child.txt'), 'c');
      await expect(coordinator.disposeRetainedDirectory(receipt)).rejects.toThrow(/acquired unknown children/);
      expect(await readFile(join(root, 'd', 'child.txt'), 'utf8')).toBe('c');
    });

    // risk: data loss — exact mkdir refuses an existing directory instead of adopting it.
    it('createDirectory refuses an existing entry', async() => {
      await mkdir(join(root, 'exists'));
      await expect(coordinator.createDirectory('exists')).rejects.toMatchObject({ code: 'EEXIST' });
    });

    // risk: data loss — a hard link created outside the namespace still counts as an existing target.
    it('treats a hard-linked existing target as occupied', async() => {
      await writeFile(join(root, 'orig.txt'), 'orig');
      await link(join(root, 'orig.txt'), join(root, 'hard.txt'));
      const staged = await stage('h.stage', 'incoming');
      await expect(coordinator.publishVerified({ staged, target: 'hard.txt', verify: accept })).rejects.toThrow(/will not overwrite/);
    });
  });

  describe('verified replacement (replaceVerified)', () => {
    const helperPresent = existsSync('/usr/local/bin/sulla-files-rename-noreplace');
    const hashOf = (expected:string) => async(file:any) => {
      const chunks:Buffer[] = []; for await (const chunk of file.createReadStream()) chunks.push(Buffer.from(chunk));
      if (Buffer.concat(chunks).toString() !== expected) throw new Error('content mismatch');
    };
    async function stage(name:string, body:string):Promise<string> {
      const path = `.sulla-trash/.operations/${ name }`;
      const handle = await coordinator.openPrivateExclusive(path);
      await handle.write(Buffer.from(body)); await handle.sync(); await handle.close();
      return path;
    }

    // risk: data accuracy — regression for #2050: replacing a verified existing target must succeed,
    // not fail EEXIST through the no-clobber helper, and must keep the prior bytes as the backup.
    it('replaces an existing verified target and keeps the prior bytes as the backup', async() => {
      await writeFile(join(root, 'note.md'), 'original');
      const staged = await stage('op1/note.md.write', 'updated by agent');
      const receipt = await coordinator.replaceVerified({ staged, target: 'note.md', backup: '.sulla-trash/.operations/op1/note.md.source',
        conflict: 'note (conflicted copy).md', verifyStaged: hashOf('updated by agent'), verifyTarget: hashOf('original') });
      expect(await readFile(join(root, 'note.md'), 'utf8')).toBe('updated by agent');
      expect(await readFile(join(root, receipt.backup), 'utf8')).toBe('original');
      expect(await coordinator.exists('note (conflicted copy).md')).toBe(false);
      await coordinator.finalizeReplacement(receipt);
      expect(await coordinator.exists(receipt.backup)).toBe(false);
      expect(await readFile(join(root, 'note.md'), 'utf8')).toBe('updated by agent');
    });

    // risk: lost update — a target that no longer matches the expected bytes is never replaced.
    it('refuses to replace a target that changed since it was indexed', async() => {
      await writeFile(join(root, 'note.md'), 'edited outside Files');
      const staged = await stage('op2/note.md.write', 'updated by agent');
      await expect(coordinator.replaceVerified({ staged, target: 'note.md', backup: '.sulla-trash/.operations/op2/note.md.source',
        conflict: 'note (conflicted copy).md', verifyStaged: hashOf('updated by agent'), verifyTarget: hashOf('original') })).rejects.toThrow(/content mismatch/);
      expect(await readFile(join(root, 'note.md'), 'utf8')).toBe('edited outside Files');
      expect(await readFile(join(root, staged), 'utf8')).toBe('updated by agent');
    });

    // risk: data loss — quarantine/rollback/retain moves still use the no-clobber helper and never
    // overwrite an occupied destination (only replaceVerified replaces).
    it.skipIf(!helperPresent)('no-clobber moves still refuse an occupied destination', async() => {
      await writeFile(join(root, 'src.txt'), 'source');
      await mkdir(join(root, '.sulla-trash/.residency'), { recursive: true });
      await writeFile(join(root, '.sulla-trash/.residency/q.evict'), 'occupied');
      await expect((coordinator as any).files.renameNoReplace('src.txt', '.sulla-trash/.residency/q.evict')).rejects.toThrow(/errno 17/);
      expect(await readFile(join(root, '.sulla-trash/.residency/q.evict'), 'utf8')).toBe('occupied');
      expect(await readFile(join(root, 'src.txt'), 'utf8')).toBe('source');
    });
  });

  describe('serialization', () => {
    // risk: data accuracy — overlapping mutations run strictly one at a time; nested calls do not deadlock.
    it('runs exclusive operations in order and allows nested calls', async() => {
      const order:string[] = [];
      let release!:() => void;
      const gate = new Promise<void>(resolve => { release = resolve });
      const first = coordinator.runExclusive(['a'], async() => {
        order.push('first:start');
        await coordinator.runExclusive(['a'], async() => { order.push('nested') });
        await gate; order.push('first:end');
      });
      const second = coordinator.runExclusive(['b'], async() => { order.push('second') });
      await Promise.resolve(); release();
      await Promise.all([first, second]);
      expect(order).toEqual(['first:start', 'nested', 'first:end', 'second']);
    });

    // risk: availability — one failed operation does not wedge the queue.
    it('keeps the queue moving after a failure', async() => {
      await expect(coordinator.runExclusive([], async() => { throw new Error('boom') })).rejects.toThrow('boom');
      expect(await coordinator.runExclusive([], async() => 'next')).toBe('next');
    });
  });
});

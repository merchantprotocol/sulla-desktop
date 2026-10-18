import fs from 'node:fs';
import path from 'node:path';

function inside(root:string, candidate:string):boolean {
  const relative = path.relative(root, candidate);

  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${ path.sep }`));
}

function sameDirectory(left:fs.BigIntStats, right:fs.BigIntStats):boolean {
  return left.dev === right.dev && left.ino === right.ino && left.isDirectory() && right.isDirectory();
}

async function assertPinnedDirectory(handle:fs.promises.FileHandle, directory:string):Promise<void> {
  const [pinned, current] = await Promise.all([
    handle.stat({ bigint: true }),
    fs.promises.lstat(directory, { bigint: true }),
  ]);

  if (!sameDirectory(pinned, current)) throw new Error('Folder parent changed while it was being created');
}

/**
 * Create one folder under the watched Files root.
 *
 * Existing symlinks are followed only when their resolved parent stays inside
 * the resolved root, matching uploadDestination's policy. Linux anchors mkdir
 * to an open parent descriptor. Every platform rejects a parent identity change
 * detected around creation, but this is not a lock against another same-user
 * process concurrently relocating that parent; callers must serialize their
 * own Files mutations.
 */
export async function createDirectoryWithinRoot(root:string, relativePath:string):Promise<void> {
  if (!relativePath || path.isAbsolute(relativePath)) throw new Error('Folder path must be relative to ~/sulla/files');

  const lexicalRoot = path.resolve(root);
  const lexicalTarget = path.resolve(lexicalRoot, relativePath);
  if (lexicalTarget === lexicalRoot || !inside(lexicalRoot, lexicalTarget)) throw new Error('Folder path escapes ~/sulla/files');

  const [realRoot, realParent] = await Promise.all([
    fs.promises.realpath(lexicalRoot),
    fs.promises.realpath(path.dirname(lexicalTarget)),
  ]);
  if (!inside(realRoot, realParent)) throw new Error('Folder path escapes ~/sulla/files');

  const parent = await fs.promises.open(realParent, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    await assertPinnedDirectory(parent, realParent);
    const name = path.basename(lexicalTarget);
    const target = process.platform === 'linux' ? `/proc/self/fd/${ parent.fd }/${ name }` : path.join(realParent, name);

    await fs.promises.mkdir(target, { recursive: false });
    await assertPinnedDirectory(parent, realParent);

    const created = await fs.promises.realpath(target);
    if (!inside(realRoot, created) || !(await fs.promises.lstat(target)).isDirectory()) {
      throw new Error('Created folder escaped ~/sulla/files');
    }
  } finally {
    await parent.close();
  }
}

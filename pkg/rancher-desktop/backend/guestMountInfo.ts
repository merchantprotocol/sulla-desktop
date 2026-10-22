/**
 * Portable guest mount probing for the Files propagation anchor.
 *
 * The Alpine guest does not reliably ship util-linux `findmnt`, so mount facts
 * come from `/proc/self/mountinfo` (always present, kernel format) and are
 * parsed here. See
 * https://www.kernel.org/doc/html/latest/filesystems/proc.html (3.5 mountinfo).
 */
import type { VMExecutor } from '@pkg/backend/backend';

export const SULLA_FILES_GUEST_MOUNT_PATH = '/mnt/sulla-files';
export const SULLA_FILES_GUEST_RUNTIME_ROOT = '/var/lib/sulla/files-fuse';

export interface MountInfoEntry {
  mountId:        number;
  parentId:       number;
  /** Path of the mounted directory inside its filesystem (bind roots differ from "/"). */
  root:           string;
  mountPoint:     string;
  mountOptions:   string;
  optionalFields: string[];
  fsType:         string;
  source:         string;
  superOptions:   string;
}

export type FilesAnchorState = 'not-mounted' | 'anchor' | 'adapter' | 'unexpected';

export interface FilesAnchorClassification {
  state:  FilesAnchorState;
  /** The topmost (visible) entry at the path, when one exists. */
  entry?: MountInfoEntry;
}

/** Decode the kernel's octal escapes (\040 space, \011 tab, \012 newline, \134 backslash). */
function unescapeMountField(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8)));
}

/** Parse /proc/<pid>/mountinfo text. Malformed lines are skipped. */
export function parseMountInfo(text: string): MountInfoEntry[] {
  const entries: MountInfoEntry[] = [];

  for (const line of (text ?? '').split('\n')) {
    const fields = line.trim().split(/\s+/);
    const separator = fields.indexOf('-', 6);

    // 6 fixed fields, optional fields, '-', then fstype, source, super options.
    if (separator < 6 || fields.length < separator + 3) continue;
    const mountId = Number(fields[0]);
    const parentId = Number(fields[1]);

    if (!Number.isInteger(mountId) || !Number.isInteger(parentId) || !/^\d+:\d+$/.test(fields[2])) continue;
    entries.push({
      mountId,
      parentId,
      root:           unescapeMountField(fields[3]),
      mountPoint:     unescapeMountField(fields[4]),
      mountOptions:   fields[5],
      optionalFields: fields.slice(6, separator),
      fsType:         fields[separator + 1],
      source:         unescapeMountField(fields[separator + 2]),
      superOptions:   fields[separator + 3] ?? '',
    });
  }

  return entries;
}

/**
 * Classify what is visible at `path`. mountinfo lists mounts in mount order, so
 * the last entry for a mount point is the topmost one.
 */
export function classifyFilesAnchor(entries: MountInfoEntry[], path: string = SULLA_FILES_GUEST_MOUNT_PATH): FilesAnchorClassification {
  const entry = entries.filter(candidate => candidate.mountPoint === path).pop();

  if (!entry) return { state: 'not-mounted' };
  // The adapter's mount shows as plain `fuse` (no subtype) in /proc/self/mountinfo
  // on the VM kernel; accept the subtype form too.
  if ((entry.fsType === 'fuse' || entry.fsType === 'fuse.sulla-files') && entry.source === 'sulla-files') return { state: 'adapter', entry };
  // Our own anchor: a non-FUSE bind of the directory onto itself. Any other
  // FUSE filesystem (fuse, fuse.*, fuseblk) is never reused.
  if (!entry.fsType.startsWith('fuse') &&
      (entry.root === path || entry.root.endsWith('/sulla-files'))) {
    return { state: 'anchor', entry };
  }

  return { state: 'unexpected', entry };
}

export function describeMountEntry(entry?: MountInfoEntry): string {
  return entry ? `${ entry.fsType } ${ entry.source }[${ entry.root }]` : 'none';
}

type GuestExec = Pick<VMExecutor, 'execCommand'>;

/** Read and classify the guest Files path. Throws when mountinfo cannot be read. */
export async function probeFilesAnchor(exec: GuestExec, path: string = SULLA_FILES_GUEST_MOUNT_PATH): Promise<FilesAnchorClassification> {
  const text = await exec.execCommand({ root: true, capture: true }, 'cat', '/proc/self/mountinfo');
  const entries = parseMountInfo(text);

  if (entries.length === 0) throw new Error('/proc/self/mountinfo returned no mount entries');

  return classifyFilesAnchor(entries, path);
}

/**
 * Ensure the guest Files propagation anchor exists before compose starts the
 * FUSE adapter: bind the directory onto itself when nothing is mounted, make
 * it shared only when no adapter is live (never change propagation on a live
 * FUSE mount), and refuse to reuse any unexpected mount.
 */
export async function prepareSullaFilesGuestAnchor(exec: GuestExec, path:string = SULLA_FILES_GUEST_MOUNT_PATH): Promise<'anchor' | 'adapter'> {

  await exec.execCommand({ root: true }, 'install', '-d', '-m', '0700', SULLA_FILES_GUEST_RUNTIME_ROOT);
  await exec.execCommand({ root: true }, 'install', '-d', '-m', '0755', path);
  let probe = await probeFilesAnchor(exec, path);

  if (probe.state === 'not-mounted') {
    await exec.execCommand({ root: true }, 'mount', '--bind', path, path);
    probe = await probeFilesAnchor(exec, path);
    if (probe.state === 'not-mounted') throw new Error(`the bind of ${ path } did not appear in /proc/self/mountinfo`);
  }
  if (probe.state === 'unexpected') {
    throw new Error(`Refusing to reuse unexpected Files propagation mount (${ describeMountEntry(probe.entry) })`);
  }
  // A surviving adapter sits above the owned anchor. The mount manager drains
  // it before the new generation and then validates the revealed anchor.
  if (probe.state === 'anchor') await exec.execCommand({ root: true }, 'mount', '--make-shared', path);

  return probe.state;
}

/** True when `path` can be listed. A dead or snapshot-less FUSE adapter fails with ENOENT/ENOTCONN here. */
export async function isGuestPathUsable(exec: GuestExec, path: string): Promise<boolean> {
  try {
    await exec.execCommand({ root: true, expectFailure: true }, 'ls', '-A', path);

    return true;
  } catch {
    return false;
  }
}

/**
 * Detach every stacked Files FUSE adapter layer at `path`, topmost first, so the owned
 * anchor underneath is visible again. A dead adapter often refuses a normal unmount, so
 * fall back to a lazy detach. Returns how many layers were detached.
 */
export async function drainFilesAdapterLayers(exec: GuestExec, path: string, maxLayers = 8): Promise<number> {
  const topIsAdapter = async(): Promise<boolean> => {
    const entries = parseMountInfo(await exec.execCommand({ root: true, capture: true }, 'cat', '/proc/self/mountinfo'));

    return classifyFilesAnchor(entries, path).state === 'adapter';
  };
  let drained = 0;

  while (drained < maxLayers && await topIsAdapter()) {
    await exec.execCommand({ root: true, expectFailure: true }, 'umount', path).catch(() => undefined);
    if (await topIsAdapter()) await exec.execCommand({ root: true, expectFailure: true }, 'umount', '-l', path).catch(() => undefined);
    drained++;
  }

  return drained;
}

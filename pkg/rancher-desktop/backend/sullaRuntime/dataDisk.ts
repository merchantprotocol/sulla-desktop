import fs from 'fs';
import path from 'path';

import { sullaRuntimeDirectory } from './artifacts';

import { spawnFile } from '@pkg/utils/childProcess';
import paths from '@pkg/utils/paths';

const QCOW2_MAGIC = Buffer.from([0x51, 0x46, 0x49, 0xfb]);

export interface DataDiskResult {
  path:   string;
  /** How the disk came to be: already there, cloned from Lima, or left for the runtime to create blank. */
  source: 'existing' | 'lima-clone' | 'blank';
}

async function exists(file: string): Promise<boolean> {
  return fs.promises.access(file).then(() => true, () => false);
}

async function isQcow2(file: string): Promise<boolean> {
  const handle = await fs.promises.open(file, 'r');

  try {
    const header = Buffer.alloc(4);

    await handle.read(header, 0, 4, 0);

    return header.equals(QCOW2_MAGIC);
  } finally {
    await handle.close();
  }
}

/**
 * Make sure the runtime has a data disk. The first time, it is an APFS clone
 * (`cp -c`, instant and copy-on-write) of Lima's raw data disk, so every
 * image, volume and container carries over. Lima's own disk is only read, and
 * only while Lima's VM is stopped. Without a Lima disk the runtime creates and
 * formats a blank one itself.
 */
export async function ensureSullaRuntimeDataDisk(isLimaRunning: () => Promise<boolean>): Promise<DataDiskResult> {
  const directory = sullaRuntimeDirectory();
  const target = path.join(directory, 'data.img');

  if (await exists(target)) {
    return { path: target, source: 'existing' };
  }

  const limaDisk = path.join(paths.lima, '0', 'diffdisk');

  if (!await exists(limaDisk)) {
    return { path: target, source: 'blank' };
  }
  if (await isLimaRunning()) {
    throw new Error('Lima is still running; its data disk cannot be cloned');
  }
  if (await isQcow2(limaDisk)) {
    throw new Error('the Lima data disk is QCOW2; only a raw (VZ) disk can be cloned');
  }

  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  const partial = `${ target }.partial`;

  await fs.promises.rm(partial, { force: true });
  try {
    await spawnFile('/bin/cp', ['-c', limaDisk, partial], { stdio: ['ignore', 'pipe', 'pipe'] });
    await fs.promises.chmod(partial, 0o600);
    await fs.promises.rename(partial, target);
  } catch (error) {
    await fs.promises.rm(partial, { force: true });
    throw error;
  }

  return { path: target, source: 'lima-clone' };
}

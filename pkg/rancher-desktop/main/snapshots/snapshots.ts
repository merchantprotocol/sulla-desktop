import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { Snapshot } from '@pkg/main/snapshots/types';
import { spawnFile } from '@pkg/utils/childProcess';
import paths from '@pkg/utils/paths';

const COMPLETE_FILE = 'complete.txt';
const COMPLETE_CONTENTS = 'The presence of this file indicates that this snapshot is complete and valid.';

interface SnapshotMetadata extends Snapshot { id: string }

class SnapshotsImpl {
  private directory(snapshot: SnapshotMetadata): string {
    return path.join(paths.snapshots, snapshot.id);
  }

  private async metadata(): Promise<SnapshotMetadata[]> {
    const entries = await fs.promises.readdir(paths.snapshots, { withFileTypes: true }).catch(() => []);
    const snapshots = await Promise.all(entries.filter(entry => entry.isDirectory()).map(async(entry) => {
      try {
        const directory = path.join(paths.snapshots, entry.name);
        await fs.promises.access(path.join(directory, COMPLETE_FILE));
        return JSON.parse(await fs.promises.readFile(path.join(directory, 'metadata.json'), 'utf8')) as SnapshotMetadata;
      } catch {
        return undefined;
      }
    }));

    return snapshots.filter((snapshot): snapshot is SnapshotMetadata => !!snapshot);
  }

  async list(): Promise<Snapshot[]> {
    return (await this.metadata()).map(({ name, created, description }) => ({ name, created, description }));
  }

  async create(snapshot: Snapshot): Promise<void> {
    if (!snapshot.name.trim() || snapshot.name !== snapshot.name.trim() || [...snapshot.name].length > 250) {
      throw new Error('Snapshot names must be 1–250 printable characters and cannot start or end with whitespace.');
    }
    if ((await this.metadata()).some(candidate => candidate.name === snapshot.name)) {
      throw new Error(`A snapshot named "${ snapshot.name }" already exists.`);
    }

    const metadata: SnapshotMetadata = { ...snapshot, id: crypto.randomUUID(), created: new Date().toISOString() };
    const directory = this.directory(metadata);

    await fs.promises.mkdir(directory, { recursive: true });
    await fs.promises.writeFile(path.join(directory, 'metadata.json'), JSON.stringify(metadata, null, 2));
    try {
      await this.copyState(directory, false);
      await fs.promises.writeFile(path.join(directory, COMPLETE_FILE), COMPLETE_CONTENTS);
    } catch (error) {
      await fs.promises.rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async restore(name: string): Promise<void> {
    const snapshot = (await this.metadata()).find(candidate => candidate.name === name);
    if (!snapshot) throw new Error(`Can't find snapshot "${ name }".`);
    await this.copyState(this.directory(snapshot), true);
  }

  async delete(name: string): Promise<void> {
    const snapshot = (await this.metadata()).find(candidate => candidate.name === name);
    if (!snapshot) throw new Error(`Can't find snapshot "${ name }".`);
    await fs.promises.rm(this.directory(snapshot), { recursive: true, force: true });
  }

  async cancel(): Promise<void> {
    // Snapshot operations now run in the main process and are serialized by callers.
  }

  private async copyState(directory: string, restore: boolean): Promise<void> {
    if (process.platform === 'win32') {
      await this.copyWindowsState(directory, restore);
      return;
    }

    const files = [
      [path.join(paths.config, 'settings.json'), path.join(directory, 'settings.json'), false],
      [path.join(paths.lima, '_config', 'override.yaml'), path.join(directory, 'override.yaml'), true],
      [path.join(paths.lima, '0', 'basedisk'), path.join(directory, 'basedisk'), false],
      [path.join(paths.lima, '0', 'diffdisk'), path.join(directory, 'diffdisk'), false],
      [path.join(paths.lima, '_config', 'user'), path.join(directory, 'user'), false],
      [path.join(paths.lima, '_config', 'user.pub'), path.join(directory, 'user.pub'), false],
      [path.join(paths.lima, '0', 'lima.yaml'), path.join(directory, 'lima.yaml'), false],
    ] as const;

    await Promise.all(files.map(async([working, saved, optional]) => {
      const source = restore ? saved : working;
      const destination = restore ? working : saved;
      try {
        await fs.promises.mkdir(path.dirname(destination), { recursive: true });
        await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_FICLONE);
      } catch (error: any) {
        if (optional && error?.code === 'ENOENT') {
          if (restore) await fs.promises.rm(destination, { force: true });
          return;
        }
        throw error;
      }
    }));
  }

  private async copyWindowsState(directory: string, restore: boolean): Promise<void> {
    const distros = [
      { name: 'rancher-desktop', location: paths.wslDistro },
      { name: 'rancher-desktop-data', location: paths.wslDistroData },
    ];
    if (restore) {
      for (const distro of distros) {
        await spawnFile('wsl.exe', ['--unregister', distro.name]).catch(() => undefined);
        await fs.promises.mkdir(distro.location, { recursive: true });
        await spawnFile('wsl.exe', ['--import', distro.name, distro.location, path.join(directory, `${ distro.name }.tar`)]);
      }
      await fs.promises.copyFile(path.join(directory, 'settings.json'), path.join(paths.config, 'settings.json'));
    } else {
      await Promise.all(distros.map(distro => spawnFile('wsl.exe', ['--export', distro.name, path.join(directory, `${ distro.name }.tar`)])));
      await fs.promises.copyFile(path.join(paths.config, 'settings.json'), path.join(directory, 'settings.json'));
    }
  }
}

export const Snapshots = new SnapshotsImpl();

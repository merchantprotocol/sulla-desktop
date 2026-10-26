import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { isSullaRuntimeActive } from '@pkg/backend/sullaRuntime/state';
import { Snapshot } from '@pkg/main/snapshots/types';
import paths from '@pkg/utils/paths';

const COMPLETE_FILE = 'complete.txt';
const COMPLETE_CONTENTS = 'The presence of this file indicates that this snapshot is complete and valid.';

interface SnapshotMetadata extends Snapshot { id: string }

/** Snapshots copy VM disks; the Sulla runtime has none to copy yet. */
class SnapshotsUnsupportedError {
  readonly isSnapshotError = true;
  message = 'Snapshots are not supported on the Sulla runtime yet';
}

function assertSnapshotsSupported(): void {
  if (isSullaRuntimeActive()) {
    throw new SnapshotsUnsupportedError();
  }
}

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
    assertSnapshotsSupported();
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
    assertSnapshotsSupported();
    const snapshot = (await this.metadata()).find(candidate => candidate.name === name);
    if (!snapshot) throw new Error(`Can't find snapshot "${ name }".`);
    await this.copyState(this.directory(snapshot), true);
  }

  async delete(name: string): Promise<void> {
    assertSnapshotsSupported();
    const snapshot = (await this.metadata()).find(candidate => candidate.name === name);
    if (!snapshot) throw new Error(`Can't find snapshot "${ name }".`);
    await fs.promises.rm(this.directory(snapshot), { recursive: true, force: true });
  }

  async cancel(): Promise<void> {
    // Snapshot operations now run in the main process and are serialized by callers.
  }

  private copyState(_directory: string, _restore: boolean): Promise<void> {
    // The Sulla runtime has no disk layout to snapshot yet.
    return Promise.reject(new SnapshotsUnsupportedError());
  }
}

export const Snapshots = new SnapshotsImpl();

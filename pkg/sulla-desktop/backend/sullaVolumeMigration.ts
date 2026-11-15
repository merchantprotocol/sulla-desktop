// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { ComposeContainerNameReconciler, ComposeLogger, ComposeServiceTarget, DockerCli } from './sullaComposeContainers';

/**
 * Moves a compose service's data from an anonymous volume (one the image
 * declares with VOLUME and compose never names) to a named volume, once.
 *
 * An anonymous volume is tied to one container: removing or replacing that
 * container outside compose's own re-create leaves the data behind in a volume
 * nothing points at. A named volume survives any re-create. This copies the old
 * volume into the named one before compose switches the service over, checks
 * the copy file by file, and only then marks the named volume as migrated. The
 * anonymous source is never deleted: it stays as a backup.
 */
export interface NamedVolumeSpec extends ComposeServiceTarget {
  /** Where the data lives inside the container, e.g. /data. */
  mountPath: string;
  /** The named volume's Docker name (compose `name:`), e.g. sulla_redis_data. */
  volume: string;
  /** The compose volume key (usually the same as `volume`). */
  composeVolume: string;
}

export type VolumeMigrationResult =
  | { kind: 'nothing-to-migrate' }
  | { kind: 'already-migrated' }
  | { kind: 'migrated'; source: string; files: number };

interface MountRow {
  Type: string;
  Name?: string;
  Destination: string;
}

/** Written into the named volume only after the copy is verified. */
export const MIGRATION_MARKER = '.sulla-volume-migrated';

export class NamedVolumeMigrator {
  constructor(
    private readonly docker: DockerCli,
    private readonly containers: ComposeContainerNameReconciler,
    private readonly project: string,
    private readonly log: ComposeLogger = console,
  ) {}

  async migrate(spec: NamedVolumeSpec): Promise<VolumeMigrationResult> {
    const container = await this.containers.resolve(spec);

    if (!container) return { kind: 'nothing-to-migrate' };
    const [mountsJson, image] = await Promise.all([
      this.docker.run(['inspect', '--format', '{{json .Mounts}}', container.id]),
      this.docker.run(['inspect', '--format', '{{.Image}}', container.id]),
    ]);
    const mount = (JSON.parse(mountsJson.trim() || '[]') as MountRow[])
      .find(entry => entry.Destination === spec.mountPath);

    if (!mount || mount.Type !== 'volume' || !mount.Name) return { kind: 'nothing-to-migrate' };
    // The container already runs on the named volume: compose switched it over.
    if (mount.Name === spec.volume) return { kind: 'already-migrated' };

    const source = mount.Name;
    const helperImage = image.trim();

    if (await this.volumeExists(spec.volume)) {
      if (await this.hasMarker(spec.volume, helperImage)) return { kind: 'already-migrated' };
    } else {
      await this.docker.run([
        'volume', 'create',
        '--label', `com.docker.compose.project=${ this.project }`,
        '--label', `com.docker.compose.volume=${ spec.composeVolume }`,
        spec.volume,
      ]);
    }

    // The target is ours and unverified: empty it, copy, then compare.
    await this.helper(helperImage, source, spec.volume, 'find /to -mindepth 1 -delete && cp -a /from/. /to/');
    const [from, to] = await Promise.all([
      this.manifest(helperImage, source),
      this.manifest(helperImage, spec.volume),
    ]);

    if (from !== to) {
      throw new Error(`Copy of ${ spec.service } data from volume ${ source } to ${ spec.volume } did not verify; the original volume is untouched`);
    }
    await this.helper(helperImage, source, spec.volume, `echo ${ source } > /to/${ MIGRATION_MARKER }`);
    const files = from.split('\n').filter(Boolean).length;

    this.log.warn(`[Sulla] Copied ${ spec.service } data (${ files } files) from anonymous volume ${ source } to named volume ${ spec.volume }; the original volume is kept as a backup`);

    return { kind: 'migrated', source, files };
  }

  private async volumeExists(volume: string): Promise<boolean> {
    return this.docker.run(['volume', 'inspect', volume]).then(() => true, () => false);
  }

  private async hasMarker(volume: string, image: string): Promise<boolean> {
    return this.docker.run([
      'run', '--rm', '--network', 'none', '--entrypoint', 'sh', '-v', `${ volume }:/to:ro`, image,
      '-c', `test -f /to/${ MIGRATION_MARKER }`,
    ]).then(() => true, () => false);
  }

  /** One line per file (checksum and path), sorted; the marker is left out. */
  private manifest(image: string, volume: string): Promise<string> {
    return this.docker.run([
      'run', '--rm', '--network', 'none', '--entrypoint', 'sh', '-v', `${ volume }:/v:ro`, image,
      '-c', `cd /v && find . -type f ! -name ${ MIGRATION_MARKER } -exec md5sum {} + | sort -k 2`,
    ]).then(output => output.trim());
  }

  private helper(image: string, source: string, target: string, script: string): Promise<string> {
    return this.docker.run([
      'run', '--rm', '--network', 'none', '--entrypoint', 'sh',
      '-v', `${ source }:/from:ro`, '-v', `${ target }:/to`, image, '-c', script,
    ]);
  }
}

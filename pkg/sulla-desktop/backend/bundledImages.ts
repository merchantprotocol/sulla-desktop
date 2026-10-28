// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Container images embedded in the app.
 *
 * The build (scripts/fetch-bundled-assets.ts) resolves every image listed in
 * packaging/bundled-images.yaml to a digest, stores the blobs once in
 * resources/darwin/images/blobs/sha256/ and writes images.lock.json. At boot
 * Desktop loads any locked image the guest does not have yet by streaming an
 * OCI archive (plus a docker-save manifest.json for the classic store) into
 * `docker load`; nothing is pulled from a registry.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';

import tar from 'tar-stream';

export const BUNDLED_IMAGE_LOCK_FILE = 'images.lock.json';
export const BUNDLED_IMAGE_LOCK_VERSION = 1;

export interface BundledImageLayer {
  digest:    string;
  size:      number;
  mediaType: string;
}

export interface BundledImage {
  /** Short name from packaging/bundled-images.yaml, e.g. `sulla-vault`. */
  name:              string;
  /** The reference the manifest tracks, e.g. `ghcr.io/merchantprotocol/sulla-vault:latest`. */
  source:            string;
  /** The immutable reference Desktop runs, e.g. `ghcr.io/merchantprotocol/sulla-vault:sha-<commit>`. */
  ref:               string;
  /** Digest `source` pointed at when the bundle was built (index or manifest). */
  sourceDigest:      string;
  manifestDigest:    string;
  manifestMediaType: string;
  manifestSize:      number;
  configDigest:      string;
  configSize:        number;
  layers:            BundledImageLayer[];
  /** Loaded when first needed instead of before the services start. */
  onDemand?:         boolean;
}

export interface BundledImageLock {
  version: typeof BUNDLED_IMAGE_LOCK_VERSION;
  /** OCI architecture of every image in the lock: `arm64` or `amd64`. */
  arch:    'arm64' | 'amd64';
  images:  BundledImage[];
}

export interface ImageReference {
  registry:   string;
  repository: string;
  tag?:       string;
  digest?:    string;
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** Parse an image reference the way Docker normalizes it (docker.io, library/). */
export function parseImageReference(reference: string): ImageReference {
  let rest = reference.trim();
  let digest: string | undefined;
  const at = rest.indexOf('@');

  if (at >= 0) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
  }
  let tag: string | undefined;
  const colon = rest.lastIndexOf(':');

  if (colon > rest.lastIndexOf('/')) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  const parts = rest.split('/');
  let registry = 'docker.io';

  if (parts.length > 1 && (parts[0].includes('.') || parts[0].includes(':') || parts[0] === 'localhost')) {
    registry = parts.shift()!;
  }
  if (registry === 'index.docker.io' || registry === 'registry-1.docker.io') registry = 'docker.io';
  let repository = parts.join('/');

  if (!repository || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/.test(repository)) {
    throw new Error(`Invalid image reference: ${ reference }`);
  }
  if (registry === 'docker.io' && !repository.includes('/')) repository = `library/${ repository }`;

  return {
    registry, repository, ...(tag ? { tag } : {}), ...(digest ? { digest } : {}),
  };
}

/** `registry/repository`, the key images are matched on regardless of tag. */
export function imageRepositoryKey(reference: string): string {
  const { registry, repository } = parseImageReference(reference);

  return `${ registry }/${ repository }`;
}

/** Fully qualified `registry/repository:tag`, as containerd names imported images. */
export function qualifiedImageName(reference: string): string {
  const { registry, repository, tag } = parseImageReference(reference);

  return `${ registry }/${ repository }:${ tag ?? 'latest' }`;
}

/** Validate a parsed lock file; throws with the first problem found. */
export function validateBundledImageLock(value: unknown): BundledImageLock {
  const lock = value as BundledImageLock;

  if (!lock || typeof lock !== 'object' || lock.version !== BUNDLED_IMAGE_LOCK_VERSION) {
    throw new Error(`unsupported lock version ${ (lock as any)?.version }`);
  }
  if (lock.arch !== 'arm64' && lock.arch !== 'amd64') throw new Error(`unsupported architecture ${ lock.arch }`);
  if (!Array.isArray(lock.images)) throw new Error('images must be a list');
  const names = new Set<string>();

  for (const image of lock.images) {
    if (!image?.name || names.has(image.name)) throw new Error(`missing or duplicate image name ${ image?.name }`);
    names.add(image.name);
    const parsed = parseImageReference(image.ref);

    if (!parsed.tag || parsed.digest) throw new Error(`${ image.name }: ref must be a tagged reference`);
    for (const digest of [image.manifestDigest, image.configDigest, ...image.layers.map(layer => layer.digest)]) {
      if (!DIGEST.test(digest)) throw new Error(`${ image.name }: invalid digest ${ digest }`);
    }
    if (!image.layers.length) throw new Error(`${ image.name }: no layers`);
  }

  return lock;
}

export function readBundledImageLock(imagesDir: string): BundledImageLock | null {
  let raw: string;

  try {
    raw = fs.readFileSync(path.join(imagesDir, BUNDLED_IMAGE_LOCK_FILE), 'utf-8');
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }

  return validateBundledImageLock(JSON.parse(raw));
}

let configuredDir: string | undefined;
let configuredLock: BundledImageLock | null | undefined;

/**
 * Point the app at its bundled images (resources/darwin/images). Until this is
 * called nothing is bundled, which keeps the image resolver pure in tests.
 */
export function useBundledImages(imagesDir: string | undefined): void {
  if (imagesDir !== configuredDir) configuredLock = undefined;
  configuredDir = imagesDir;
}

export function bundledImagesDir(): string | undefined {
  return configuredDir;
}

/** The lock for the configured directory, or null when the app has no bundled images. */
export function currentBundledImageLock(): BundledImageLock | null {
  if (!configuredDir) return null;
  if (configuredLock === undefined) {
    try {
      configuredLock = readBundledImageLock(configuredDir);
    } catch (error) {
      console.error(`[bundled-images] ignoring the unreadable lock in ${ configuredDir }:`, error);
      configuredLock = null;
    }
  }

  return configuredLock;
}

export function findBundledImage(lock: BundledImageLock | null | undefined, reference: string): BundledImage | undefined {
  if (!lock) return undefined;
  let key: string;

  try {
    key = imageRepositoryKey(reference);
  } catch {
    return undefined;
  }

  return lock.images.find(image => imageRepositoryKey(image.ref) === key);
}

/**
 * Replace each literal compose image that has a bundled copy with its pinned
 * reference. Images written as `${VAR:-default}` keep their override. Returns
 * the services that now run a bundled image.
 */
export function pinComposeImages(compose: { services?: Record<string, any> }, lock: BundledImageLock | null | undefined): string[] {
  const pinned: string[] = [];

  for (const [service, definition] of Object.entries(compose.services ?? {})) {
    const image = definition?.image;

    if (typeof image !== 'string' || image.includes('$') || definition.build) continue;
    const bundled = findBundledImage(lock, image);

    if (bundled) {
      definition.image = bundled.ref;
      pinned.push(service);
    }
  }

  return pinned;
}

export function blobPath(imagesDir: string, digest: string): string {
  const [algorithm, hex] = digest.split(':');

  return path.join(imagesDir, 'blobs', algorithm, hex);
}

export function bundledImageSize(image: BundledImage): number {
  return image.manifestSize + image.configSize + image.layers.reduce((total, layer) => total + layer.size, 0);
}

interface ArchiveEntry {
  name:     string;
  size:     number;
  /** Inline contents, or undefined to stream the blob at `file`. */
  data?:    Buffer;
  file?:    string;
}

/**
 * The files of a loadable archive for one image: an OCI layout (used by the
 * containerd image store, which keeps the registry manifest digest) and a
 * docker-save manifest.json (used by the classic store). Blob files are the
 * registry's compressed layers, which both loaders accept.
 */
export function imageArchiveEntries(imagesDir: string, image: BundledImage): ArchiveEntry[] {
  const { tag } = parseImageReference(image.ref);
  const blob = (digest: string) => `blobs/${ digest.replace(':', '/') }`;
  const json = (name: string, value: unknown): ArchiveEntry => {
    const data = Buffer.from(JSON.stringify(value));

    return { name, size: data.length, data };
  };
  const entries: ArchiveEntry[] = [
    json('oci-layout', { imageLayoutVersion: '1.0.0' }),
    json('index.json', {
      schemaVersion: 2,
      mediaType:     'application/vnd.oci.image.index.v1+json',
      manifests:     [{
        mediaType:   image.manifestMediaType,
        digest:      image.manifestDigest,
        size:        image.manifestSize,
        annotations: {
          'io.containerd.image.name':         qualifiedImageName(image.ref),
          'org.opencontainers.image.ref.name': tag,
        },
      }],
    }),
    json('manifest.json', [{
      Config:   blob(image.configDigest),
      RepoTags: [image.ref],
      Layers:   image.layers.map(layer => blob(layer.digest)),
    }]),
  ];
  const seen = new Set<string>();

  for (const [digest, size] of [
    [image.manifestDigest, image.manifestSize],
    [image.configDigest, image.configSize],
    ...image.layers.map(layer => [layer.digest, layer.size] as const),
  ] as const) {
    if (seen.has(digest)) continue;
    seen.add(digest);
    entries.push({ name: blob(digest), size, file: blobPath(imagesDir, digest) });
  }

  return entries;
}

/** Stream the archive for one image as a tar. `onBytes` reports blob bytes as they are read. */
export function imageArchiveStream(imagesDir: string, image: BundledImage, onBytes?: (bytes: number) => void): Readable {
  const pack = tar.pack();
  const entries = imageArchiveEntries(imagesDir, image);

  (async() => {
    for (const entry of entries) {
      if (entry.data) {
        await new Promise<void>((resolve, reject) => {
          pack.entry({ name: entry.name, size: entry.size, mode: 0o644 }, entry.data!, error => error ? reject(error) : resolve());
        });
        continue;
      }
      const { size } = await fs.promises.stat(entry.file!);

      if (size !== entry.size) throw new Error(`${ entry.name } is ${ size } bytes, expected ${ entry.size }`);
      await new Promise<void>((resolve, reject) => {
        const sink = pack.entry({ name: entry.name, size: entry.size, mode: 0o644 }, error => error ? reject(error) : resolve());
        const source = fs.createReadStream(entry.file!);

        source.on('data', chunk => onBytes?.(chunk.length));
        source.on('error', reject);
        source.pipe(sink);
      });
    }
    pack.finalize();
  })().catch(error => pack.destroy(error));

  return pack;
}

/** What the loader needs from the guest's Docker. */
export interface GuestDocker {
  /** The local image ID for a reference, or undefined when the image is missing. */
  imageId(reference: string): Promise<string | undefined>;
  /** Feed an image archive to `docker load`. */
  load(archive: Readable): Promise<void>;
}

/** The containerd image store reports the manifest digest as the ID; the classic store, the config digest. */
export function isBundledImagePresent(image: BundledImage, imageId: string | undefined): boolean {
  return imageId === image.manifestDigest || imageId === image.configDigest;
}

export interface EnsureBundledImagesOptions {
  lock:        BundledImageLock;
  imagesDir:   string;
  docker:      GuestDocker;
  /** Which images to make present; defaults to every image that is not on-demand. */
  filter?:     (image: BundledImage) => boolean;
  /** Called while loading with bytes done / total over the images being loaded. */
  onProgress?: (done: number, total: number, image: BundledImage) => void;
  log?:        Pick<Console, 'log' | 'warn'>;
}

export interface EnsureBundledImagesResult {
  present: string[];
  loaded:  string[];
  failed:  { name: string; error: Error }[];
}

const inFlight = new Map<string, Promise<void>>();

/**
 * Make each selected bundled image present in the guest, loading only the
 * missing ones. Idempotent and safe to call concurrently (one load per image).
 * A failed image is reported, not thrown: compose then tries its normal path.
 */
export async function ensureBundledImages(options: EnsureBundledImagesOptions): Promise<EnsureBundledImagesResult> {
  const {
    lock, imagesDir, docker, filter = image => !image.onDemand, onProgress, log = console,
  } = options;
  const result: EnsureBundledImagesResult = { present: [], loaded: [], failed: [] };
  const missing: BundledImage[] = [];

  for (const image of lock.images.filter(filter)) {
    if (isBundledImagePresent(image, await docker.imageId(image.ref).catch(() => undefined))) {
      result.present.push(image.name);
    } else {
      missing.push(image);
    }
  }
  const total = missing.reduce((sum, image) => sum + bundledImageSize(image), 0);
  let done = 0;

  for (const image of missing) {
    const started = Date.now();
    let loading = inFlight.get(image.manifestDigest);

    if (!loading) {
      loading = docker.load(imageArchiveStream(imagesDir, image, (bytes) => {
        done += bytes;
        onProgress?.(done, total, image);
      })).finally(() => inFlight.delete(image.manifestDigest));
      inFlight.set(image.manifestDigest, loading);
    }
    try {
      await loading;
      const id = await docker.imageId(image.ref).catch(() => undefined);

      if (!isBundledImagePresent(image, id)) {
        throw new Error(`after loading, ${ image.ref } is ${ id ?? 'missing' } instead of ${ image.manifestDigest }`);
      }
      result.loaded.push(image.name);
      log.log(`[bundled-images] loaded ${ image.ref } in ${ Date.now() - started }ms`);
    } catch (error) {
      result.failed.push({ name: image.name, error: error instanceof Error ? error : new Error(String(error)) });
      log.warn(`[bundled-images] could not load ${ image.ref }:`, error);
    }
  }

  return result;
}

/** Guest Docker reached through `sulla-runtime exec`. */
export function sullaRuntimeGuestDocker(runtimeBinary: string): GuestDocker {
  const run = (args: string[], stdin?: Readable): Promise<string> => new Promise((resolve, reject) => {
    const proc = spawn(runtimeBinary, ['exec', '--', ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    proc.stdout.on('data', chunk => stdout.push(chunk));
    proc.stderr.on('data', chunk => stderr.push(chunk));
    proc.once('error', reject);
    proc.stdin.on('error', () => { /* the exit status reports it */ });
    if (stdin) {
      stdin.once('error', (error) => {
        proc.kill();
        reject(error);
      });
      stdin.pipe(proc.stdin);
    } else {
      proc.stdin.end();
    }
    proc.once('close', (code, signal) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString('utf-8'));
      } else {
        reject(new Error(`${ args.join(' ') } exited with ${ code ?? signal }: ${ Buffer.concat(stderr).toString('utf-8').trim() }`));
      }
    });
  });

  return {
    async imageId(reference) {
      try {
        return (await run(['docker', 'image', 'inspect', '--format', '{{.Id}}', reference])).trim() || undefined;
      } catch {
        return undefined;
      }
    },
    async load(archive) {
      await run(['docker', 'load', '--quiet'], archive);
    },
  };
}

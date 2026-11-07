// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Puts everything the app would otherwise download after install into
 * resources/darwin/ (gitignored; electron-builder ships resources/):
 *
 *   images  — every service container image (packaging/bundled-images.yaml),
 *             pinned in resources/darwin/images/images.lock.json
 *   whisper — the ggml base.en speech model and the whisper-cli binary
 *   agent-desktop — accessibility-tree CLI and its matching macOS helper
 *   audio   — the BlackHole 2ch loopback driver installer package, ONLY with
 *             SULLA_BUNDLE_BLACKHOLE=1 (off by default until we hold a
 *             redistribution license; without it the app installs BlackHole
 *             through Homebrew as before)
 *
 *   node scripts/ts-wrapper.js scripts/fetch-bundled-assets.ts [arm64|x86_64]
 *
 * `just build` and `yarn package` run it. Everything is pinned (digests,
 * sha256, commits) and re-runs only download what changed.
 * SULLA_BUNDLE_SKIP=all (or a comma list of images,whisper,agent-desktop,audio) skips parts
 * for quick dev iterations; packaging then warns the app is not fit to release.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { blobPath, readBundledImageLock } from '../pkg/sulla-desktop/backend/bundledImages';

import {
  fetchBundledImages, lockIsComplete, ociArch, skippedParts,
} from './lib/bundled-images';
import { BundledImageSafetyScanner } from './lib/bundled-image-safety';
import { download } from './lib/download';
import { simpleSpawn } from './simple_process';

export { skippedParts };

/** whisper.cpp's ggml conversion of OpenAI Whisper base.en (MIT), pinned to a Hugging Face revision. */
export const WHISPER_MODEL = {
  name:     'base.en',
  file:     'ggml-base.en.bin',
  url:      'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.en.bin',
  sha256:   'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002',
  size:     147_964_211,
  notice:   'ggml-base.en.bin: OpenAI Whisper base.en weights (MIT License) converted by whisper.cpp (MIT License).\n' +
    'Source: https://huggingface.co/ggerganov/whisper.cpp (revision 5359861c739e955e79d9a303bcbc70fb988958b1)\n',
} as const;

/** Pinned upstream macOS CLI archives (Apache-2.0). */
export const AGENT_DESKTOP_RELEASES = {
  arm64: {
    url:    'https://github.com/vercel-labs/agent-desktop/releases/download/v1.0.2/agent-desktop-v1.0.2-aarch64-apple-darwin.tar.gz',
    sha256: '7bee385196d7b478de80cf05ca4304aaa38f0eba593b3406ad3c247c1773be19',
  },
  x86_64: {
    url:    'https://github.com/vercel-labs/agent-desktop/releases/download/v1.0.2/agent-desktop-v1.0.2-x86_64-apple-darwin.tar.gz',
    sha256: '8edda6df17eafc042395502a823dbb8415bc8ac14835a6731e4d8becc9cb4121',
  },
} as const;

const AGENT_DESKTOP_NOTICE = `agent-desktop v1.0.2 by Vercel Labs, distributed unmodified under the Apache License 2.0.
Source and license: https://github.com/vercel-labs/agent-desktop/tree/v1.0.2
`;

/** The signed, notarized BlackHole 2ch installer from Existential Audio (GPL-3.0 source; see NOTICE). */
export const LOOPBACK_DRIVER = {
  file:   'BlackHole2ch-0.6.1.pkg',
  url:    'https://existential.audio/downloads/BlackHole2ch-0.6.1.pkg',
  sha256: 'c829afa041a9f6e1b369c01953c8f079740dd1f02421109855829edc0d3c1988',
  notice: 'BlackHole2ch-0.6.1.pkg: BlackHole 2ch 0.6.1 by Existential Audio Inc., installed unmodified.\n' +
    'BlackHole source code is licensed under the GNU General Public License v3.0: https://github.com/ExistentialAudio/BlackHole\n',
} as const;

/**
 * BlackHole's official installer is "All rights reserved" and its README asks
 * non-GPLv3 projects for a license, so it is embedded only on explicit opt-in.
 */
export function blackholeBundlingEnabled(value = process.env.SULLA_BUNDLE_BLACKHOLE): boolean {
  return value?.trim() === '1';
}

export function bundleRoot(root = process.cwd()): string {
  return path.join(root, 'resources', 'darwin');
}

async function fileSha256(file: string): Promise<string | undefined> {
  if (!fs.existsSync(file)) return undefined;
  const hash = crypto.createHash('sha256');

  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);

  return hash.digest('hex');
}

async function fetchPinned(url: string, file: string, sha256: string, notice: string): Promise<void> {
  if (await fileSha256(file) !== sha256) {
    await download(url, file, { expectedChecksum: sha256, overwrite: true, access: fs.constants.R_OK });
  }
  await fs.promises.writeFile(path.join(path.dirname(file), 'NOTICE'), notice);
}

/** Reject OCI layers that would make Apple notarization inspect unsigned host binaries. */
export async function assertBundledImagesSafe(imagesDir: string): Promise<void> {
  const lock = readBundledImageLock(imagesDir);

  if (!lock) throw new Error('cannot inspect bundled images without images.lock.json');
  const findings = await new BundledImageSafetyScanner().scan(imagesDir, lock);
  const warnings = findings.filter(finding => finding.level === 'warning');
  const problems = findings.filter(finding => finding.level === 'error');

  for (const warning of warnings) {
    console.warn(`bundled image safety warning: ${ warning.image } ${ warning.layer } ${ warning.path }: ${ warning.reason }`);
  }

  if (problems.length) {
    const details = problems.map(problem => `${ problem.image } ${ problem.layer } ${ problem.path }: ${ problem.reason }`).join('\n');

    throw new Error(`bundled image safety check failed:\n${ details }`);
  }
}

/** Fetch every bundled asset for `arch` (`arm64` or `x86_64`). */
export async function fetchBundledAssets(arch: string, skip = skippedParts(), root = process.cwd()): Promise<void> {
  const darwin = bundleRoot(root);

  for (const part of skip) console.log(`fetch-bundled-assets: skipping ${ part } (SULLA_BUNDLE_SKIP); this tree cannot be packaged for release`);
  if (!skip.has('images')) {
    await fetchBundledImages({
      manifestFile: path.join(root, 'packaging', 'bundled-images.yaml'),
      imagesDir:    path.join(darwin, 'images'),
      arch:         ociArch(arch),
      serviceTag:   process.env.SULLA_SERVICE_IMAGE_TAG?.trim() || undefined,
    });
    await assertBundledImagesSafe(path.join(darwin, 'images'));
  }
  if (!skip.has('whisper')) {
    await fetchPinned(WHISPER_MODEL.url, path.join(darwin, 'whisper', WHISPER_MODEL.file), WHISPER_MODEL.sha256, WHISPER_MODEL.notice);
    await simpleSpawn('bash', [path.join(root, 'scripts', 'build-whisper-cli.sh'), arch === 'x64' ? 'x86_64' : arch]);
  }
  if (!skip.has('agent-desktop')) {
    const release = AGENT_DESKTOP_RELEASES[arch === 'x64' || arch === 'x86_64' ? 'x86_64' : 'arm64'];
    const destination = path.join(darwin, 'agent-desktop');
    const archive = path.join(destination, 'agent-desktop.tar.gz');
    await fs.promises.mkdir(destination, { recursive: true });
    if (await fileSha256(archive) !== release.sha256) {
      await download(release.url, archive, { expectedChecksum: release.sha256, overwrite: true, access: fs.constants.R_OK });
    }
    await simpleSpawn('tar', ['-xzf', archive, '-C', destination, 'agent-desktop', 'agent-desktop-macos-helper']);
    await Promise.all(['agent-desktop', 'agent-desktop-macos-helper'].map(file => fs.promises.chmod(path.join(destination, file), 0o755)));
    await fs.promises.writeFile(path.join(destination, 'NOTICE'), AGENT_DESKTOP_NOTICE);
    await fs.promises.rm(archive, { force: true });
  }
  const driverPkg = path.join(darwin, 'audio-driver', LOOPBACK_DRIVER.file);

  if (!blackholeBundlingEnabled()) {
    // Never ship a copy left behind by an earlier opt-in build.
    await fs.promises.rm(driverPkg, { force: true });
    await fs.promises.rm(path.join(darwin, 'audio-driver', 'NOTICE'), { force: true });
    console.log('fetch-bundled-assets: not bundling the BlackHole installer (set SULLA_BUNDLE_BLACKHOLE=1 to opt in); the app installs it via Homebrew');
  } else if (!skip.has('audio')) {
    await fetchPinned(LOOPBACK_DRIVER.url, driverPkg, LOOPBACK_DRIVER.sha256, LOOPBACK_DRIVER.notice);
  }
}

/**
 * Problems that make `resourcesDarwin` unfit to ship for `arch`; empty when
 * complete. Packaging calls this on the copied app resources.
 */
export function bundledAssetProblems(resourcesDarwin: string, arch: string, skip = skippedParts()): string[] {
  const problems: string[] = [];

  if (!skip.has('images')) {
    const imagesDir = path.join(resourcesDarwin, 'images');

    try {
      const lock = readBundledImageLock(imagesDir);

      if (!lock) {
        problems.push('images/images.lock.json is missing');
      } else if (lock.arch !== ociArch(arch)) {
        problems.push(`the bundled images are linux/${ lock.arch }, not linux/${ ociArch(arch) }`);
      } else if (!lockIsComplete(imagesDir, lock)) {
        const missing = lock.images.flatMap(image => [image.configDigest, ...image.layers.map(layer => layer.digest)])
          .filter(digest => !fs.existsSync(blobPath(imagesDir, digest)));

        problems.push(`image blobs are missing or truncated (${ missing.length } missing)`);
      }
    } catch (error) {
      problems.push(`images/images.lock.json is invalid: ${ (error as Error).message }`);
    }
  }
  if (!skip.has('whisper')) {
    if (fs.statSync(path.join(resourcesDarwin, 'whisper', WHISPER_MODEL.file), { throwIfNoEntry: false })?.size !== WHISPER_MODEL.size) {
      problems.push(`whisper/${ WHISPER_MODEL.file } is missing`);
    }
    if (!fs.existsSync(path.join(resourcesDarwin, 'bin', 'whisper-cli'))) problems.push('bin/whisper-cli is missing');
  }
  if (!skip.has('agent-desktop')) {
    for (const file of ['agent-desktop', 'agent-desktop-macos-helper', 'NOTICE']) {
      if (!fs.existsSync(path.join(resourcesDarwin, 'agent-desktop', file))) problems.push(`agent-desktop/${ file } is missing`);
    }
  }
  const driverPkg = path.join(resourcesDarwin, 'audio-driver', LOOPBACK_DRIVER.file);

  if (!blackholeBundlingEnabled()) {
    if (fs.existsSync(driverPkg)) problems.push(`audio-driver/${ LOOPBACK_DRIVER.file } is present but SULLA_BUNDLE_BLACKHOLE is not set`);
  } else if (!skip.has('audio') && !fs.existsSync(driverPkg)) {
    problems.push(`audio-driver/${ LOOPBACK_DRIVER.file } is missing`);
  }

  return problems;
}

// Run as a script (package.ts imports the functions instead).
if (path.basename(process.argv[1] ?? '').startsWith('fetch-bundled-assets')) {
  if (process.platform !== 'darwin') {
    console.log('fetch-bundled-assets: macOS only, nothing to do');
    process.exit(0);
  }
  const arch = process.argv[2] ?? process.arch;

  fetchBundledAssets(arch).catch((error) => {
    console.error(`fetch-bundled-assets: ${ error?.message ?? error }`);
    process.exit(1);
  });
}

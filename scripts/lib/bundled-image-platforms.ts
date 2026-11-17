// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Pin check for packaging/bundled-images.yaml: every pinned, immutable Sulla
 * image must publish a multi-arch index that includes both linux/amd64 and
 * linux/arm64. A single-arch tag (for example one pushed from a local arm64
 * build) passes the build on the Mac but breaks `scripts/package.ts --arch=x64`.
 */

import { type ImageReference, parseImageReference } from '../../pkg/sulla-desktop/backend/bundledImages';
import { type ManifestEntry, type OciArch, Registry, selectPlatformManifest } from './bundled-images';

export const REQUIRED_PLATFORMS: OciArch[] = ['amd64', 'arm64'];

/** A pinned image whose index is missing platforms, or is not published at all. */
export interface PlatformProblem {
  image:     string;
  source:    string;
  missing:   OciArch[];
  published: boolean;
}

/** Pure decision: which required platforms an image index lacks. No I/O. */
export class ImageIndexPlatformPolicy {
  constructor(private readonly platforms: OciArch[] = REQUIRED_PLATFORMS) {}

  missingPlatforms(index: unknown): OciArch[] {
    return this.platforms.filter((arch) => {
      try {
        selectPlatformManifest(index, arch);

        return false;
      } catch {
        return true;
      }
    });
  }
}

/** Selects the entries the platform check applies to: pinned, always-loaded GHCR images. */
export class PinnedImageSelector {
  static readonly registry = 'ghcr.io';
  static readonly namespace = 'merchantprotocol/';

  select(images: ManifestEntry[]): ManifestEntry[] {
    return images.filter(image => !image.onDemand && this.isPinned(image.source));
  }

  isPinned(source: string): boolean {
    const reference: ImageReference = parseImageReference(source);

    return reference.registry === PinnedImageSelector.registry &&
      reference.repository.startsWith(PinnedImageSelector.namespace) &&
      /^sha-[0-9a-f]+$/.test(reference.tag ?? '');
  }
}

/** Fetches each selected image index from the registry and reports what it lacks. */
export class BundledImagePlatformGuard {
  constructor(
    private readonly registry: Registry = new Registry(),
    private readonly policy: ImageIndexPlatformPolicy = new ImageIndexPlatformPolicy(),
    private readonly selector: PinnedImageSelector = new PinnedImageSelector(),
  ) {}

  async findProblems(images: ManifestEntry[]): Promise<PlatformProblem[]> {
    const problems: PlatformProblem[] = [];

    for (const image of this.selector.select(images)) {
      const { registry, repository, tag } = parseImageReference(image.source);
      const published = await this.registry.manifest(registry, repository, tag!);

      if (!published) {
        problems.push({ image: image.name, source: image.source, missing: [...REQUIRED_PLATFORMS], published: false });
        continue;
      }
      const missing = this.policy.missingPlatforms(JSON.parse(published.body.toString()));

      if (missing.length) problems.push({ image: image.name, source: image.source, missing, published: true });
    }

    return problems;
  }
}

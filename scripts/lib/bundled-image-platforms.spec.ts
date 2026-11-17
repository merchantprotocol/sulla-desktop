// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { ImageIndexPlatformPolicy, PinnedImageSelector } from './bundled-image-platforms';
import type { ManifestEntry } from './bundled-images';

const PINNED = 'ghcr.io/merchantprotocol/sulla-tools:sha-ce74b3442baf43c52c232a8962169de367ea65af';

class ImageIndexFixture {
  static entry(os: string, architecture: string, variant?: string): Record<string, unknown> {
    return { mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: `sha256:${ os }${ architecture }`, size: 1, platform: { os, architecture, ...(variant ? { variant } : {}) } };
  }

  static index(...platforms: Array<[string, string, string?]>): unknown {
    return { schemaVersion: 2, manifests: platforms.map(([os, arch, variant]) => ImageIndexFixture.entry(os, arch, variant)) };
  }
}

describe('ImageIndexPlatformPolicy.missingPlatforms', () => {
  const policy = new ImageIndexPlatformPolicy();

  it('reports nothing for a multi-arch index with linux/amd64 and linux/arm64', () => { // risk: release integrity
    expect(policy.missingPlatforms(ImageIndexFixture.index(['linux', 'amd64'], ['linux', 'arm64']))).toEqual([]);
  });

  it('reports amd64 when the index is arm64-only (the sha-ef9d4c3 regression)', () => { // risk: release integrity
    expect(policy.missingPlatforms(ImageIndexFixture.index(['linux', 'arm64']))).toEqual(['amd64']);
  });

  it('reports arm64 when the index is amd64-only', () => { // risk: release integrity
    expect(policy.missingPlatforms(ImageIndexFixture.index(['linux', 'amd64']))).toEqual(['arm64']);
  });

  it('ignores attestation entries marked unknown/unknown', () => { // risk: release integrity
    const index = ImageIndexFixture.index(['linux', 'arm64'], ['unknown', 'unknown']);

    expect(policy.missingPlatforms(index)).toEqual(['amd64']);
  });

  it('reports every required platform for a document with no manifests', () => { // risk: release integrity
    expect(policy.missingPlatforms({ schemaVersion: 2 })).toEqual(['amd64', 'arm64']);
    expect(policy.missingPlatforms(null)).toEqual(['amd64', 'arm64']);
  });

  it('accepts an arm64 entry with the v8 variant and rejects another variant', () => { // risk: release integrity
    expect(policy.missingPlatforms(ImageIndexFixture.index(['linux', 'amd64'], ['linux', 'arm64', 'v8']))).toEqual([]);
    expect(policy.missingPlatforms(ImageIndexFixture.index(['linux', 'amd64'], ['linux', 'arm64', 'v7']))).toEqual(['arm64']);
  });
});

describe('PinnedImageSelector.select', () => {
  const selector = new PinnedImageSelector();
  const entry = (name: string, source: string, onDemand?: boolean): ManifestEntry => ({ name, source, onDemand });

  it('selects pinned sha tags of Sulla GHCR images that load at startup', () => { // risk: release integrity
    const selected = selector.select([entry('sulla-tools', PINNED)]);

    expect(selected.map(image => image.name)).toEqual(['sulla-tools']);
  });

  it('skips on-demand images, floating tags and third-party images', () => { // risk: release integrity
    const selected = selector.select([
      entry('sulla-agent', PINNED, true),
      entry('sulla-workflows', 'ghcr.io/merchantprotocol/sulla-workflows:latest'),
      entry('redis', 'redis:7-alpine'),
    ]);

    expect(selected).toEqual([]);
  });
});

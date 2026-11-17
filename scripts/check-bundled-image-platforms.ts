// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Fails when a pinned bundled image index lacks linux/amd64 or linux/arm64.
// Needs the registry, so it only runs with --registry (`just vault-pin-check`).

import path from 'path';

import { BundledImagePlatformGuard } from './lib/bundled-image-platforms';
import { readImageManifest } from './lib/bundled-images';

const manifestFile = path.resolve('packaging', 'bundled-images.yaml');

async function main(): Promise<void> {
  if (!process.argv.includes('--registry')) {
    console.log('bundled-image-platforms: skipped (pass --registry to check the GHCR indexes)');

    return;
  }

  const problems = await new BundledImagePlatformGuard().findProblems(readImageManifest(manifestFile));

  if (problems.length) {
    for (const problem of problems) {
      const reason = problem.published ? `index lacks ${ problem.missing.map(arch => `linux/${ arch }`).join(', ') }` : 'is not published in the registry';

      console.error(`bundled-image-platforms: ${ problem.image } (${ problem.source }) ${ reason }`);
    }
    throw new Error(`${ problems.length } pinned image(s) fail the platform check; repin to a sha tag whose index has linux/amd64 and linux/arm64`);
  }
  console.log('bundled-image-platforms: OK (every pinned image index has linux/amd64 and linux/arm64)');
}

main().catch((error) => {
  console.error(`bundled-image-platforms: FAILED: ${ error.message }`);
  process.exit(1);
});

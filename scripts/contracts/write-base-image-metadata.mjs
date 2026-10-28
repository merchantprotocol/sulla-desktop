// SPDX-License-Identifier: GPL-2.0-or-later
import fs from 'node:fs';

const [image, digest, commit, output = 'base-image-metadata.json'] = process.argv.slice(2);
const digestPattern = /^sha256:[0-9a-f]{64}$/;
if (!/^ghcr\.io\/merchantprotocol\/sulla-[a-z0-9-]+$/.test(image ?? '')) throw new Error('image must be a Sulla GHCR repository without a tag');
if (!digestPattern.test(digest ?? '')) throw new Error('digest must be an exact sha256 OCI digest');
if (!/^[0-9a-f]{40}$/.test(commit ?? '')) throw new Error('commit must be a full 40-character SHA');
const metadata = { schemaVersion: 1, source: { repository: 'merchantprotocol/sulla-desktop', commit }, image, digest, platforms: ['linux/amd64', 'linux/arm64'] };
fs.writeFileSync(output, `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx' });

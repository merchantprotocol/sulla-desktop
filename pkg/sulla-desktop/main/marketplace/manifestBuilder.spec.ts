// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildManifest } from './manifestBuilder';

describe('buildManifest recipe ports', () => {
  let bundleRoot: string | undefined;

  afterEach(() => {
    if (bundleRoot) fs.rmSync(bundleRoot, { recursive: true, force: true });
    bundleRoot = undefined;
  });

  function buildRecipeWithPorts(composePorts: string[]): Record<string, unknown> {
    bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'marketplace-recipe-ports-'));
    fs.writeFileSync(path.join(bundleRoot, 'installation.yaml'), 'id: port-test\nname: Port test\n');
    fs.writeFileSync(path.join(bundleRoot, 'docker-compose.yml'), [
      'services:',
      '  app:',
      '    image: example.test/app:latest',
      '    ports:',
      ...composePorts.map((port) => `      - "${ port }"`),
      '',
    ].join('\n'));

    return buildManifest('recipe', { slug: 'port-test', bundleRoot });
  }

  it('uses the published port for a host-IP-bound mapping', () => {
    // risk: data accuracy — do not report the IP octet as a published port.
    const manifest = buildRecipeWithPorts(['127.0.0.1:30180:80']);

    expect(manifest.recipeSummary).toMatchObject({ ports: [30180] });
  });

  it('continues to use the published port in ordinary host:container mappings', () => {
    // risk: data accuracy — keep existing published-port reporting intact.
    const manifest = buildRecipeWithPorts(['30180:80', '8081:8080']);

    expect(manifest.recipeSummary).toMatchObject({ ports: [30180, 8081] });
  });
});

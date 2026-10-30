// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-ports-'));
jest.unstable_mockModule('@pkg/utils/paths', () => ({ default: { appHome } }));

afterAll(() => fs.rmSync(appHome, { recursive: true, force: true }));

test('resolution is idempotent across module restarts', async() => {
  const first = await import('../serviceDirectory');
  const port = first.servicePort('vault');
  jest.resetModules();
  const restarted = await import('../serviceDirectory');
  expect(restarted.servicePort('vault')).toBe(port);
});

test('a conflict moves only that service and persists the reassignment', async() => {
  const directory = await import('../serviceDirectory');
  const occupied = directory.servicePort('files');
  const vault = directory.servicePort('vault');
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(occupied, '127.0.0.1', resolve));
  const reassigned = await directory.resolveServicePort('files');
  server.close();
  expect(reassigned).not.toBe(occupied);
  expect(directory.servicePort('vault')).toBe(vault);
  expect(JSON.parse(fs.readFileSync(path.join(appHome, 'ports.json'), 'utf8')).ports.files).toBe(reassigned);
});

test('service ports and origins are not frozen in module-scope constants', () => {
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const offenders: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') visit(absolute);
      } else if (/\.[cm]?tsx?$/.test(entry.name)) {
        const source = fs.readFileSync(absolute, 'utf8');
        if (/^(?:export\s+)?const\s+\w+\s*=\s*service(?:Port|Origin)\s*\(/m.test(source)) {
          offenders.push(path.relative(sourceRoot, absolute));
        }
      }
    }
  };
  visit(sourceRoot);
  expect(offenders).toEqual([]);
});

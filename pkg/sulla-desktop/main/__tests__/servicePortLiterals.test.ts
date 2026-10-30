// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'node:fs';
import path from 'node:path';

test('service host-port literals live only in the directory', () => {
  const root = path.resolve(__dirname, '../..');
  const servicePorts = /(?:127\.0\.0\.1|localhost):(?:3011[6-9]|3012[0-6]|30135|3020|6107|6108)\b/;
  const allowed = new Set(['main/serviceDirectory.ts', 'main/__tests__/servicePortLiterals.test.ts']);
  const stray: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) { if (!['node_modules', 'dist', '__tests__'].includes(entry.name)) visit(absolute); continue }
      const relative = path.relative(root, absolute);
      if (!allowed.has(relative) && /\.(?:ts|vue|ya?ml)$/.test(entry.name) && servicePorts.test(fs.readFileSync(absolute, 'utf8'))) stray.push(relative);
    }
  };
  visit(root);
  expect(stray).toEqual([]);
});

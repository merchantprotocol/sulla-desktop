// SPDX-License-Identifier: GPL-2.0-or-later

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

const SOURCE_EXTENSIONS = new Set([
  '.bash', '.c', '.cc', '.cjs', '.cpp', '.css', '.go', '.h', '.hpp', '.html',
  '.js', '.jsx', '.mjs', '.py', '.rs', '.scss', '.sh', '.sql', '.ts', '.tsx',
  '.vue', '.yaml', '.yml',
]);
const GPL_COMPATIBLE_IDENTIFIERS = new Set([
  'GPL-2.0-or-later',
  'Apache-2.0',
  'MIT',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
]);
// These are notices/license texts, not source files. Keep third-party attribution intact.
const THIRD_PARTY_NOTICE_ALLOWLIST = new Set([
  'LICENSES/Apache-2.0.txt',
  'NOTICE.md',
]);
const FAIR_CODE_PATTERN = /Sulla[ -]Fair-Code|Sulla Fair-Code License|LicenseRef-Sulla-Fair-Code/i;
const SPDX_PATTERN = /SPDX-License-Identifier:\s*([^\s*<>]+)/;

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
const errors = [];

for (const file of tracked) {
  let contents;
  try {
    contents = readFileSync(file, 'utf8');
  } catch {
    continue; // Binary file.
  }

  if (!THIRD_PARTY_NOTICE_ALLOWLIST.has(file) && FAIR_CODE_PATTERN.test(contents)) {
    errors.push(`${file}: mentions the Sulla Fair-Code License`);
  }
  if (!SOURCE_EXTENSIONS.has(extname(file).toLowerCase())) {
    continue;
  }

  const header = contents.split(/\r?\n/, 40).join('\n');
  const match = header.match(SPDX_PATTERN);
  if (!match) {
    errors.push(`${file}: tracked source file has no SPDX-License-Identifier in its first 40 lines`);
  } else if (!GPL_COMPATIBLE_IDENTIFIERS.has(match[1])) {
    errors.push(`${file}: SPDX identifier ${match[1]} is not on the GPL-compatible allowlist`);
  }
}

if (errors.length) {
  console.error(`License scan failed with ${errors.length} issue(s):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
console.log(`License scan passed: ${tracked.length} tracked files; source headers and Fair-Code references verified.`);

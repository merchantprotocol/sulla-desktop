// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Loads the cross-runtime test tools (esbuild, miniflare). CI installs them
// outside the workspace and points AGENT_CORE_TOOLS_DIR at that prefix, so
// they never enter the repo lockfile.

import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function loadTool(name) {
  const base = process.env.AGENT_CORE_TOOLS_DIR ? join(process.env.AGENT_CORE_TOOLS_DIR, 'noop.js') : import.meta.url;
  const resolved = createRequire(base).resolve(name);
  return import(pathToFileURL(resolved).href);
}

/** Bundle a test entry into one file the target runtime can load. */
export async function bundle(entry, options) {
  const esbuild = await loadTool('esbuild');
  const out = await esbuild.build({
    entryPoints: [entry],
    bundle:      true,
    write:       false,
    logLevel:    'silent',
    ...options,
  });
  return out.outputFiles[0].text;
}

export function report(runtime, results) {
  let failed = 0;
  for (const r of results) {
    console.log(`${ r.ok ? 'ok' : 'not ok' } - golden (${ runtime }): ${ r.name }`);
    for (const p of r.problems) console.log(`    ${ p }`);
    if (!r.ok) {
      failed++;
      if (process.env.GITHUB_ACTIONS) console.log(`::error title=Golden (${ runtime })::${ r.name }: ${ r.problems.join(' | ').slice(0, 1500) }`);
    }
  }
  console.log(`# ${ runtime }: ${ results.length - failed } passed, ${ failed } failed`);
  if (failed || !results.length) process.exitCode = 1;
}

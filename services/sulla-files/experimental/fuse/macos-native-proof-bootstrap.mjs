import { mkdirSync, lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { app, dialog } from 'electron';

const profileRoot = process.env.SULLA_FILES_PROOF_ELECTRON_ROOT;
if (!profileRoot || !profileRoot.startsWith('/') || resolve(profileRoot) !== profileRoot) {
  throw new Error('SULLA_FILES_PROOF_ELECTRON_ROOT must be an absolute canonical path');
}

mkdirSync(profileRoot, { recursive: true, mode: 0o700 });
const rootInfo = lstatSync(profileRoot);
if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || rootInfo.uid !== process.getuid() || (rootInfo.mode & 0o777) !== 0o700 || realpathSync(profileRoot) !== profileRoot) {
  throw new Error('Native proof Electron root failed its owner, type, mode, or canonical-path check');
}

const isolatedPaths = Object.fromEntries(['user-data', 'session-data', 'cache', 'media-cache', 'logs', 'crash-dumps'].map(name => {
  const path = join(profileRoot, name);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700 || realpathSync(path) !== path) {
    throw new Error(`Native proof Electron ${ name } directory failed its isolation check`);
  }
  return [name, path];
}));

for (const [name, path] of Object.entries({
  'user-data-dir': isolatedPaths['user-data'],
  'disk-cache-dir': isolatedPaths.cache,
  'media-cache-dir': isolatedPaths['media-cache'],
  'crash-dumps-dir': isolatedPaths['crash-dumps'],
  'log-file': join(isolatedPaths.logs, 'electron.log'),
})) {
  if (app.commandLine.getSwitchValue(name) !== path) throw new Error(`Native proof requires --${ name } isolation at Electron launch`);
}

if (app.isReady()) throw new Error('Native proof Electron app became ready before profile isolation');
app.setPath('userData', isolatedPaths['user-data']);
app.setPath('sessionData', isolatedPaths['session-data']);
app.setPath('logs', isolatedPaths.logs);
app.setPath('crashDumps', isolatedPaths['crash-dumps']);

globalThis[Symbol.for('sulla.files.nativeProof.electron')] = { app, dialog };
await import('./live-proof.mjs');

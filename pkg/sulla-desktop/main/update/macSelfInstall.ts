// SPDX-License-Identifier: GPL-2.0-or-later
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// "Sulla" is a trademark. See TRADEMARK.md.

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Electron from 'electron';

export interface StagedMacUpdate {
  appPath:       string;
  stagedAppPath: string;
  stageDir:      string;
}

function run(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      const result = {
        stdout: Buffer.concat(stdout).toString().trim(),
        stderr: Buffer.concat(stderr).toString().trim(),
      };

      if (code === 0) resolve(result);
      else reject(new Error(`${ path.basename(command) } exited with code ${ code }: ${ result.stderr || result.stdout }`));
    });
  });
}

function runningBundlePath(): string {
  let candidate = Electron.app.getPath('exe');

  while (candidate !== path.dirname(candidate)) {
    if (candidate.endsWith('.app')) return candidate;
    candidate = path.dirname(candidate);
  }
  throw new Error(`Could not resolve the running application bundle from ${ Electron.app.getPath('exe') }`);
}

async function plistValue(appPath: string, key: string): Promise<string> {
  const plist = path.join(appPath, 'Contents', 'Info.plist');
  const { stdout } = await run('/usr/libexec/PlistBuddy', ['-c', `Print :${ key }`, plist]);

  return stdout;
}

async function teamIdentifier(appPath: string): Promise<string> {
  const { stderr } = await run('/usr/bin/codesign', ['-dv', '--verbose=4', appPath]);
  const match = stderr.match(/^TeamIdentifier=(.+)$/m);

  if (!match?.[1] || match[1] === 'not set') {
    throw new Error(`No TeamIdentifier found for ${ appPath }`);
  }
  return match[1].trim();
}

async function cleanStaleStages(appParent: string): Promise<void> {
  const entries = await fs.promises.readdir(appParent, { withFileTypes: true });

  await Promise.all(entries
    .filter(entry => entry.isDirectory() && entry.name.startsWith('.sulla-update-'))
    .map(entry => fs.promises.rm(path.join(appParent, entry.name), { recursive: true, force: true })));
}

/** Extract and authenticate a checksum-verified electron-updater artifact. */
export async function stageMacUpdate(zipPath: string, targetVersion: string): Promise<StagedMacUpdate> {
  const appPath = runningBundlePath();
  const appParent = path.dirname(appPath);

  try {
    await fs.promises.access(appParent, fs.constants.W_OK);
  } catch {
    throw new Error(`Sulla can't replace ${ appPath }: not writable by this user`);
  }

  await cleanStaleStages(appParent);
  const stageDir = path.join(appParent, `.sulla-update-${ targetVersion }`);

  try {
    await fs.promises.mkdir(stageDir, { recursive: false });
    await run('/usr/bin/ditto', ['-x', '-k', zipPath, stageDir]);

    const entries = await fs.promises.readdir(stageDir, { withFileTypes: true });
    const bundles = entries.filter(entry => entry.isDirectory() && entry.name.endsWith('.app'));

    if (bundles.length !== 1) {
      throw new Error(`Update archive contained ${ bundles.length } application bundles; expected one`);
    }
    const stagedAppPath = path.join(stageDir, bundles[0].name);
    const [runningIdentifier, stagedIdentifier, stagedVersion] = await Promise.all([
      plistValue(appPath, 'CFBundleIdentifier'),
      plistValue(stagedAppPath, 'CFBundleIdentifier'),
      plistValue(stagedAppPath, 'CFBundleShortVersionString'),
    ]);

    if (stagedIdentifier !== runningIdentifier) {
      throw new Error(`Update bundle identifier ${ stagedIdentifier } does not match ${ runningIdentifier }`);
    }
    if (stagedVersion !== targetVersion) {
      throw new Error(`Update bundle version ${ stagedVersion } does not match ${ targetVersion }`);
    }
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', stagedAppPath]);
    const [runningTeam, stagedTeam] = await Promise.all([
      teamIdentifier(appPath),
      teamIdentifier(stagedAppPath),
    ]);

    if (stagedTeam !== runningTeam) {
      throw new Error(`Update signing TeamIdentifier ${ stagedTeam } does not match ${ runningTeam }`);
    }

    return { appPath, stagedAppPath, stageDir };
  } catch (error) {
    await fs.promises.rm(stageDir, { recursive: true, force: true });
    throw error;
  }
}

const INSTALL_SCRIPT = `#!/bin/sh
pid="$1"
app="$2"
staged="$3"
log="$4"
stage_dir=$(dirname "$staged")
helper_dir=$(dirname "$0")
previous=$(dirname "$app")/.Sulla\\ Desktop.app.previous
mkdir -p "$(dirname "$log")"
exec >>"$log" 2>&1
timestamp() { date '+%Y-%m-%dT%H:%M:%S%z'; }
note() { echo "$(timestamp) $*"; }
restore() {
  note "restoring previous application bundle"
  rm -rf "$app"
  if mv "$previous" "$app"; then open "$app" || true; fi
}
rm -f "$0"
rmdir "$helper_dir" 2>/dev/null || true
note "installer helper started for pid $pid"
count=0
while kill -0 "$pid" 2>/dev/null; do
  if [ "$count" -ge 900 ]; then note "app still running after 15 minutes; leaving it as is"; exit 1; fi
  sleep 1
  count=$((count + 1))
done
note "application process exited"
note "removing stale rollback bundle"
rm -rf "$previous"
note "preserving current application bundle"
if ! mv "$app" "$previous"; then note "failed to preserve current application bundle"; exit 1; fi
note "installing staged application bundle"
if ! mv "$staged" "$app"; then note "failed to install staged bundle"; mv "$previous" "$app" || true; open "$app" || true; exit 1; fi
note "clearing quarantine attribute"
if ! /usr/bin/xattr -dr com.apple.quarantine "$app"; then note "failed to clear quarantine attribute"; restore; exit 1; fi
note "opening new application"
if ! open "$app"; then note "new application failed to open"; restore; exit 1; fi
note "new application opened successfully"
note "removing rollback bundle and staging directory"
rm -rf "$previous"
rmdir "$stage_dir" 2>/dev/null || true
note "installation complete"
exit 0
`;

/** Spawn the detached swap helper before shutdown so a spawn failure leaves the app alive. */
export async function launchMacInstaller(update: StagedMacUpdate): Promise<void> {
  const helperDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sulla-update-installer-'));
  const scriptPath = path.join(helperDir, 'install.sh');
  const logPath = path.join(Electron.app.getPath('home'), 'Library', 'Logs', 'sulla-desktop', 'update-install.log');

  await fs.promises.writeFile(scriptPath, INSTALL_SCRIPT, { mode: 0o700 });
  await new Promise<void>((resolve, reject) => {
    const child = spawn('/bin/sh', [scriptPath, String(process.pid), update.appPath, update.stagedAppPath, logPath], {
      detached: true,
      stdio:    'ignore',
    });

    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  }).catch(async(error) => {
    await fs.promises.rm(helperDir, { recursive: true, force: true });
    throw error;
  });
}

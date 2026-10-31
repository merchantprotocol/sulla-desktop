// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * The Sulla VM guest image ships Node and npm but not the provider CLIs, so a
 * fresh install has no `claude` or `codex`. Install the pinned versions on
 * demand (global npm installs land on the persistent data disk, so this runs
 * once per install). Each CLI installs at most once at a time; a failed
 * install is retried on the next call.
 */
import * as childProcess from 'child_process';

import Logging from '@pkg/utils/logging';
import paths from '@pkg/utils/paths';

const log = Logging.background;

export const GUEST_CLI_PACKAGES = {
  claude: '@anthropic-ai/claude-code@2.1.312',
  codex:  '@openai/codex@0.162.1',
} as const;

export type GuestCli = keyof typeof GUEST_CLI_PACKAGES;

const inflight = new Map<GuestCli, Promise<void>>();

function install(cli: GuestCli): Promise<void> {
  const script = `command -v ${ cli } >/dev/null 2>&1 && exit 0; sudo npm install --global --no-fund --no-audit ${ GUEST_CLI_PACKAGES[cli] } && command -v ${ cli }`;

  return new Promise<void>((resolve, reject) => {
    const proc = childProcess.spawn(paths.sullaRuntime, ['exec', '--', 'sh', '-lc', script], { env: { ...process.env } });
    let output = '';
    const timer = setTimeout(() => { try { proc.kill() } catch { /* dead */ } reject(new Error(`installing ${ cli } timed out after 5 minutes`)) }, 5 * 60 * 1000);
    proc.stdout.on('data', (d) => { output += d.toString() });
    proc.stderr.on('data', (d) => { output += d.toString() });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`npm exited ${ code }: ${ output.trim().split('\n').slice(-3).join(' ') }`));
    });
    proc.on('error', (err) => { clearTimeout(timer); reject(err) });
  });
}

/** Make sure a provider CLI exists in the VM, installing the pinned version if needed. */
export function ensureGuestCli(cli: GuestCli): Promise<void> {
  let run = inflight.get(cli);
  if (!run) {
    run = install(cli).catch((err) => {
      inflight.delete(cli);
      throw err;
    });
    inflight.set(cli, run);
  }
  return run;
}

/** Install every provider CLI in the background once the VM is up. */
export function prepareGuestClis(): void {
  for (const cli of Object.keys(GUEST_CLI_PACKAGES) as GuestCli[]) {
    void ensureGuestCli(cli).then(
      () => log.log(`[guestClis] ${ cli } is ready in the VM`),
      err => log.warn(`[guestClis] ${ cli } is not installed yet: ${ err instanceof Error ? err.message : String(err) }`),
    );
  }
}

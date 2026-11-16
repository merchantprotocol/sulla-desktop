// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import * as path from 'node:path';

export interface GuestWorkspaceCleanupDecision {
  remove: boolean;
  reason: string;
  /**
   * The workspace is a stable conversation workspace that the next turn
   * reopens. It is kept by design, so it is not a recovery workspace.
   */
  persistent?: boolean;
}

export interface GuestWorkspaceCleanupInspectorOptions {
  /** Job-scoped workspaces created for one container run (runtime/agents). */
  ephemeralRoot:  string;
  /** Stable per-conversation workspaces reused across turns (runtime/conversations). */
  persistentRoot: string;
  /** Runs one bounded command in the Sulla guest and returns its stdout. */
  run(args: string[]): Promise<string>;
}

export const RETAINED_WORKSPACE_REASON = 'workspace retained pending independent publication and file-preservation verification';

/**
 * Decides what happens to a container job's guest workspace once the
 * container is gone. Only provably empty job workspaces are removed. Anything
 * with content is retained: a guest-controlled origin ref is not proof of
 * publication and git status omits ignored output, and running git against a
 * container-written repository could execute its configured filters.
 */
export class GuestWorkspaceCleanupInspector {
  constructor(private readonly options: GuestWorkspaceCleanupInspectorOptions) {}

  async inspect(workspacePath: string): Promise<GuestWorkspaceCleanupDecision> {
    const resolved = path.posix.resolve(workspacePath);
    if (GuestWorkspaceCleanupInspector.isUnder(resolved, this.options.persistentRoot)) {
      return { remove: false, persistent: true, reason: 'persistent conversation workspace kept for the next turn' };
    }
    if (!GuestWorkspaceCleanupInspector.isUnder(resolved, this.options.ephemeralRoot)) {
      throw new Error(`Guest workspace is outside the agent workspace roots: ${ workspacePath }`);
    }
    const state = await this.options.run([
      'sh', '-c',
      [
        'set -eu',
        '[ -e "$1" ] || [ -L "$1" ] || { printf missing; exit 0; }',
        'resolved=$(realpath "$1")',
        'case "$resolved" in "$2"/*) ;; *) exit 73;; esac',
        '[ -d "$resolved" ] && [ ! -L "$1" ] || exit 74',
        'if [ -z "$(find "$resolved" -mindepth 1 -maxdepth 1 -print -quit)" ]; then printf empty; else printf content; fi',
      ].join('; '),
      'sulla-guest-workspace-inspect', resolved, this.options.ephemeralRoot,
    ]);
    switch (state.trim()) {
    case 'missing': return { remove: true, reason: 'workspace was already removed' };
    case 'empty': return { remove: true, reason: 'workspace was empty' };
    case 'content': return { remove: false, reason: RETAINED_WORKSPACE_REASON };
    default: throw new Error(`Unexpected guest workspace inspection result for ${ resolved }`);
    }
  }

  private static isUnder(candidate: string, root: string): boolean {
    return candidate.startsWith(`${ root }/`);
  }
}

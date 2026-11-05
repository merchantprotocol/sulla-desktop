// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export type StopAttribution = { agentId: string; threadId: string } | { system: string } | 'human';

export class StopAttributionFormatter {
  format(stoppedBy: StopAttribution | undefined, reason: string | undefined): string {
    if (!stoppedBy) return '';
    const actor = stoppedBy === 'human' ? 'human' : 'system' in stoppedBy ? stoppedBy.system : `${ stoppedBy.agentId } (${ stoppedBy.threadId })`;
    return `Stopped by ${ actor } — ${ reason || 'unspecified' }`;
  }
}

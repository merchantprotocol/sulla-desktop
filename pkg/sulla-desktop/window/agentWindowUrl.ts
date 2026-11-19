// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

/** Shared agent-window URL construction for primary and hosted tab renderers. */
export const webRoot = 'app://.';
export const mainUrl = `${ webRoot }/agent.html`;
export function agentWindowUrl(query = ''): string {
  return `${ mainUrl }${ query ? `?${ query }` : '' }`;
}

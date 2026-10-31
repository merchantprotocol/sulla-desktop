// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { ipcRenderer } from '@pkg/utils/ipcRenderer';

/** Add a wizard step or click to first-run.log. Never pass secrets. */
export function traceFirstRun(area: string, event: string, details?: Record<string, unknown>): void {
  try {
    ipcRenderer.send('first-run:trace', area, event, details);
  } catch { /* tracing is best-effort */ }
}

/**
 * Is this Mac still signed in from the Account step? The Cloud session and the
 * key that creates the vault live in main's memory until the vault holds them,
 * so a restart loses them. `email` is set when main still knows it.
 */
export async function firstRunAccountSignedIn(): Promise<{ signedIn: boolean; email?: string }> {
  const session = await ipcRenderer.invoke('sulla-cloud:first-run-session' as any).catch(() => null);
  const email = typeof session?.email === 'string' && session.email ? session.email : undefined;

  if (session?.sessionInMemory && session?.masterKeyRetained) {
    traceFirstRun('account', 'Cloud sign-in still in memory');

    return { signedIn: true, email };
  }
  // The vault may already have been created and hold the session.
  const saved = await ipcRenderer.invoke('first-run:account-saved' as any).catch(() => null);

  traceFirstRun('account', saved?.saved ? 'Cloud sign-in already in the vault' : 'Cloud sign-in is gone; it must be entered again', {
    sessionInMemory: !!session?.sessionInMemory, keyInMemory: !!session?.masterKeyRetained, inVault: saved?.saved === true,
  });

  return { signedIn: saved?.saved === true, email };
}

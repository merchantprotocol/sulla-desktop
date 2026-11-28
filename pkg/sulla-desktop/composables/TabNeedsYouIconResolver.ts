// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export type TabStatusIcon = { kind: 'alert' } | { kind: 'standard'; path: string };

/** Keeps a needs-you tab visibly distinct while restoring its ordinary icon afterward. */
export class TabNeedsYouIconResolver {
  resolve(mode: string | undefined, activity: string | undefined, standardPath: string): TabStatusIcon {
    return mode === 'chat' && activity === 'you' ? { kind: 'alert' } : { kind: 'standard', path: standardPath };
  }
}

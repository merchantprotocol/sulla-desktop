// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { chatActivityByTab } from '../chat/messages/chatActivityStore';

/** The turn meter follows execution; attention dots follow the thread status line. */
export function headerTabActivity(tab: { id:string; mode:string }, running:ReadonlySet<string>) {
  const working = tab.mode === 'chat' && running.has(tab.id);
  const activity = tab.mode === 'chat' ? chatActivityByTab.get(tab.id) ?? (working ? 'working' as const : undefined) : undefined;
  return { working, activity };
}

export interface ActiveTabIndicatorMetrics {
  x:     number;
  width: number;
}

export function isTabCloseable(pinned: boolean, supportsClose = true): boolean {
  return supportsClose && !pinned;
}

export function measureActiveTabIndicator(container: HTMLElement): ActiveTabIndicatorMetrics | null {
  const active = container.querySelector<HTMLElement>('.tab-item[data-active="true"]');

  if (!active) return null;

  return {
    x:     active.offsetLeft,
    width: active.offsetWidth,
  };
}

// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { chatActivityByTab } from '../chat/messages/chatActivityStore';

/** The turn meter follows execution; attention dots follow the thread status line. */
export function headerTabActivity(tab: { id: string; mode: string }, running: ReadonlySet<string>) {
  if (tab.mode !== 'chat') return { working: false, activity: undefined };
  const status = chatActivityByTab.get(tab.id);
  const working = running.has(tab.id) || status?.active === true;
  const activity = working && (!status || status.state === 'idle') ? 'working' as const : status?.state;
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

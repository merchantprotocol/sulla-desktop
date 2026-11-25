// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { TabStripPopupPalette } from '../shared/TabStripPopup';

export class TabStripPopupAnchor {
  constructor(private readonly viewport: Window) {}

  locate(element: HTMLElement, clip?: HTMLElement) {
    if (!element.isConnected || !element.getClientRects().length) return undefined;
    const style = this.viewport.getComputedStyle(element);

    if (style.visibility !== 'visible' || element.checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) === false) return undefined;
    const bounds = element.getBoundingClientRect();
    const viewport = clip?.getBoundingClientRect();
    const x = Math.max(bounds.left, viewport?.left ?? 0, 0);

    if (x >= Math.min(bounds.right, viewport?.right ?? this.viewport.innerWidth, this.viewport.innerWidth) ||
        bounds.bottom <= 0 || bounds.top >= this.viewport.innerHeight) return undefined;
    const palette: TabStripPopupPalette = {};
    const tokens: (keyof TabStripPopupPalette)[] = [
      'bg-elevated', 'bg-surface-hover', 'border-default', 'text-primary', 'text-muted', 'status-warning', 'status-error',
    ];

    for (const token of tokens) {
      const value = style.getPropertyValue(`--${ token }`).trim();

      if (value) palette[token] = value;
    }
    return { anchor: { x, y: bounds.bottom + 6 }, palette };
  }
}

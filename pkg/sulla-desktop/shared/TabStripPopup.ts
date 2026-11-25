// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export type TabStripPopupPalette = Partial<Record<
  'bg-elevated' | 'bg-surface-hover' | 'border-default' | 'text-primary' | 'text-muted' | 'status-warning' | 'status-error',
  string
>>;

export interface TabAttentionRow {
  id:     string;
  title:  string;
  reason: string;
  state:  'you' | 'stalled';
  iconPath?: string;
}

export interface TabAttentionMenu {
  id:      string;
  anchor:  { x: number; y: number };
  palette: TabStripPopupPalette;
}

export interface TabContextMenuRequest {
  screenX:    number;
  screenY:    number;
  items:      (string | TabAttentionRow)[];
  tabData:    Record<string, unknown>;
  attention?: TabAttentionMenu;
  update?:    boolean;
}

export interface TabHoverRequest {
  id:      string;
  anchor:  { x: number; y: number };
  palette: TabStripPopupPalette;
  title:   string;
  status:  string;
  detail:  string;
}

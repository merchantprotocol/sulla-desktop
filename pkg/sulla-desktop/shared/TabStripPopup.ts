// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { TabGroupColorToken } from './TabGroupColor';

export type TabStripPopupPalette = Partial<Record<
  'bg-elevated' | 'bg-surface-hover' | 'border-default' | 'elev-raised' | 'text-primary' | 'text-muted' | 'status-warning' | 'status-error',
  string
>>;

export interface TabAttentionRow {
  id:        string;
  title:     string;
  reason:    string;
  state:     'you' | 'stalled' | 'working' | 'waiting' | 'quiet' | 'idle';
  iconPath?: string;
}

export interface TabAttentionMenu {
  anchor:  { x: number; y: number };
  palette: TabStripPopupPalette;
  title?:  string;
}

export interface TabGroupMenuOption {
  id:         string;
  name:       string;
  colorToken: TabGroupColorToken;
  color:      string;
}

export interface TabStandardContextMenuRequest {
  screenX:    number;
  screenY:    number;
  items:      string[];
  requestId:  string;
  groups?:    TabGroupMenuOption[];
  activeGroupId?: string;
  attention?: never;
  update?:    never;
}

export interface TabAttentionContextMenuRequest {
  items:     TabAttentionRow[];
  requestId: string;
  attention: TabAttentionMenu;
  update:    false;
}

export type TabContextMenuRequest = TabStandardContextMenuRequest | TabAttentionContextMenuRequest;

export interface TabGroupPopoverSwatch {
  token: TabGroupColorToken;
  label: string;
  color: string;
}

export interface TabGroupPopoverChange {
  name?:       string;
  colorToken?: TabGroupColorToken;
}

export interface TabGroupPopoverRequest {
  requestId: string;
  groupId:   string;
  name:      string;
  colorToken: TabGroupColorToken;
  focus:     'name' | 'color';
  anchor:    { x: number; y: number; aboveY: number };
  palette:   TabStripPopupPalette;
  swatches:  TabGroupPopoverSwatch[];
}

export interface TabHoverRequest {
  id:      string;
  anchor:  { x: number; y: number; aboveY: number };
  palette: TabStripPopupPalette;
  title:   string;
  status:  string;
  detail:  string;
}

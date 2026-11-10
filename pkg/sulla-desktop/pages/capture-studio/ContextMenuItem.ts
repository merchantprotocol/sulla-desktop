// SPDX-License-Identifier: GPL-2.0-or-later
export interface CtxMenuItem {
  id:         string;
  label:      string;
  thumbnail?: string;
  active?:    boolean;
  disabled?:  boolean;
  divider?:   boolean;
  badge?:     string;
  children?:  CtxMenuItem[];
  action:     () => void;
}

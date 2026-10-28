// SPDX-License-Identifier: GPL-2.0-or-later
// Sulla Desktop · https://sulladesktop.com
// Portions Copyright SUSE LLC and the Rancher Desktop contributors, licensed under
// the Apache License 2.0 (LICENSES/Apache-2.0.txt).
// Modifications Copyright (c) 2025-2026 Merchant Protocol LLC, licensed under the
// GPL-2.0-or-later (LICENSE).
// "Sulla" is a trademark. See TRADEMARK.md.

import { NavItemName } from '@pkg/config/transientSettings';

interface NavItems {
  name:  NavItemName;
  tabs?: string[];
}
const vmTabs: string[] = ['hardware', 'volumes', 'network', 'emulation'];

export const preferencesNavItems: NavItems[] = [
  {
    name: 'Application',
    tabs: ['general', 'behavior', 'environment'],
  },
  { name: 'Appearance' },
  { name: 'Files' },
  {
    name: 'Virtual Machine',
    tabs: vmTabs,
  },
  {
    name: 'Container Engine',
    tabs: ['general', 'allowed-images'],
  },
];

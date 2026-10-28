// Sulla Desktop · https://sulladesktop.com
// Portions Copyright SUSE LLC and the Rancher Desktop contributors, licensed under
// the Apache License 2.0 (LICENSES/Apache-2.0.txt).
// Modifications Copyright (c) 2025-2026 Merchant Protocol LLC, licensed under the
// GPL-2.0-or-later (LICENSE).
// "Sulla" is a trademark. See TRADEMARK.md.

import _ from 'lodash';

import { RecursivePartial, RecursiveReadonly } from '@pkg/utils/typeUtils';

export const navItemNames = [
  'Application',
  'Appearance',
  'Files',
  'Virtual Machine',
  'Container Engine',
] as const;

export type NavItemName = typeof navItemNames[number];

export const defaultTransientSettings = {
  noModalDialogs: false,
  preferences:    {
    navItem: {
      current:     'Application' as NavItemName,
      currentTabs: {
        Application:        'general',
        Files:              undefined,
        'Virtual Machine':  'hardware',
        'Container Engine': 'general',
      } as Record<NavItemName, string | undefined>,
    },
  },
};
export type TransientSettings = typeof defaultTransientSettings;

class TransientSettingsImpl {
  private _value = _.cloneDeep(defaultTransientSettings);

  get value(): RecursiveReadonly<TransientSettings> {
    return this._value;
  }

  update(transientSettings: RecursivePartial<TransientSettings>) {
    _.merge(this._value, transientSettings);
  }
}

export const TransientSettings = new TransientSettingsImpl();

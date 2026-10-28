// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** @jest-environment node */

import _ from 'lodash';
import semver from 'semver';

import mockModules from '@pkg/utils/testUtils/mockModules';

mockModules({
  '@pkg/utils/version':   { getProductionVersion: () => '1.0.0' },
  '@pkg/utils/osVersion': { getMacOsVersion: () => new semver.SemVer('15.0.0'), fetchMacOsVersion: () => Promise.resolve() },
});

const { CURRENT_SETTINGS_VERSION, defaultSettings } = await import('@pkg/config/settings');
const { migrateSpecifiedSettingsToCurrentVersion } = await import('@pkg/config/settingsImpl');
const { default: SettingsValidator } = await import('@pkg/main/commandServer/settingsValidator');

/** A settings.json from before Kubernetes and WSL were removed. */
function oldSettingsFile(): Record<string, any> {
  return {
    ..._.cloneDeep(defaultSettings),
    version:        18,
    WSL:            { integrations: { Ubuntu: true } },
    kubernetes:     {
      version: '1.30.1', port: 6443, enabled: true, options: { traefik: true, flannel: true }, ingress: { localhostOnly: false },
    },
    portForwarding: { includeKubernetesServices: true },
    experimental:   { ..._.cloneDeep(defaultSettings.experimental), kubernetes: { options: { spinkube: false } } },
  };
}

describe('settings migration to macOS only', () => {
  it('drops the WSL and Kubernetes settings from an old settings file', () => {
    const migrated: Record<string, any> = migrateSpecifiedSettingsToCurrentVersion(oldSettingsFile(), false);

    expect(migrated.version).toBe(CURRENT_SETTINGS_VERSION);
    expect(migrated).not.toHaveProperty('WSL');
    expect(migrated).not.toHaveProperty('kubernetes');
    expect(migrated).not.toHaveProperty('portForwarding');
    expect(migrated.experimental).not.toHaveProperty('kubernetes');
    expect(migrated.application.adminAccess).toBe(defaultSettings.application.adminAccess);
  });

  it('accepts the migrated settings back through the validator unchanged', () => {
    const current = _.cloneDeep(defaultSettings);
    const migrated = migrateSpecifiedSettingsToCurrentVersion(oldSettingsFile(), false);
    const [, errors] = new SettingsValidator().validateSettings(current, migrated, {});

    expect(errors).toEqual([]);
  });

  it('migrates an old API payload that still names Kubernetes', () => {
    const migrated = migrateSpecifiedSettingsToCurrentVersion({ version: 10, kubernetes: { enabled: true } }, false);
    const [, errors] = new SettingsValidator().validateSettings(_.cloneDeep(defaultSettings), migrated, {});

    expect(migrated).not.toHaveProperty('kubernetes');
    expect(errors).toEqual([]);
  });
});

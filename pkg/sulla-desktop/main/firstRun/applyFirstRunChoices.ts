// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import { setCloudPreferences } from '@pkg/main/cloud/cloudSettings';
import { getFirstRunState } from '@pkg/main/firstRun/firstRunState';

const APPLIED_KEY = 'firstRunChoicesAppliedV1';
let started = false;

async function applyOnce(): Promise<boolean> {
  if (await SullaSettingsModel.get(APPLIED_KEY, false) === true) return true;
  const state = getFirstRunState();
  if (state.onboardingComplete !== true) return false;
  const choices = state.choices ?? {};
  if (typeof choices.primaryUserName === 'string') await SullaSettingsModel.set('primaryUserName', choices.primaryUserName, 'string');
  if (typeof choices.sullaEmail === 'string') await SullaSettingsModel.set('sullaEmail', choices.sullaEmail, 'string');
  await SullaSettingsModel.set('sullaSubscribeToUpdates', choices.sullaSubscribeToUpdates === true, 'boolean');
  await SullaSettingsModel.set('sullaCloudLinked', choices.accountLinked === true, 'boolean');
  if (choices.cloudPreferences && typeof choices.cloudPreferences === 'object') {
    await setCloudPreferences(choices.cloudPreferences as Record<string, unknown>);
  }
  // Credentials collected by first run may still be waiting in memory for the
  // vault. Choose from those plus durable integration accounts, never from a
  // hardcoded provider that the user did not connect.
  const { getModelProviderService } = await import('@pkg/agent/services/ModelProviderService');
  await getModelProviderService().reconcilePrimaryProvider();
  // Compatibility only. Durable first-run completion is owned by first-run-state.json.
  await SullaSettingsModel.set('sullaPassword', 'vault-protected', 'string');
  await SullaSettingsModel.set('firstRunCredentialsNeeded', false, 'boolean');
  await SullaSettingsModel.set(APPLIED_KEY, true, 'boolean');
  return true;
}

export function applyFirstRunChoicesWhenReady(): void {
  if (started) return;
  started = true;
  let delay = 1_000;
  const attempt = async() => {
    try {
      if (await applyOnce()) return;
    } catch {
      // Postgres may still be starting. The durable JSON remains the source.
    }
    setTimeout(() => { void attempt() }, delay);
    delay = Math.min(delay * 2, 60_000);
  };
  void attempt();
}

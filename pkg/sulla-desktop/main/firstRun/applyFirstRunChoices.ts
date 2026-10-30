// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'node:fs';
import path from 'node:path';

import { app } from 'electron';

import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import { setCloudPreferences } from '@pkg/main/cloud/cloudSettings';

const APPLIED_KEY = 'firstRunChoicesAppliedV1';
let started = false;

interface StoredFirstRunState {
  version?: number;
  onboardingComplete?: boolean;
  choices?: Record<string, unknown>;
}

function readState(): StoredFirstRunState | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'first-run-state.json'), 'utf8')) as StoredFirstRunState;
  } catch {
    return undefined;
  }
}

async function applyOnce(): Promise<boolean> {
  if (await SullaSettingsModel.get(APPLIED_KEY, false) === true) return true;
  const state = readState();
  if (state?.version !== 1 || state.onboardingComplete !== true) return false;
  const choices = state.choices ?? {};
  if (typeof choices.primaryUserName === 'string') await SullaSettingsModel.set('primaryUserName', choices.primaryUserName, 'string');
  if (typeof choices.sullaEmail === 'string') await SullaSettingsModel.set('sullaEmail', choices.sullaEmail, 'string');
  await SullaSettingsModel.set('sullaSubscribeToUpdates', choices.sullaSubscribeToUpdates === true, 'boolean');
  await SullaSettingsModel.set('sullaCloudLinked', choices.accountLinked === true, 'boolean');
  if (choices.cloudPreferences && typeof choices.cloudPreferences === 'object') {
    await setCloudPreferences(choices.cloudPreferences as Record<string, unknown>);
  }
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

/**
 * Sulla Desktop · https://sulladesktop.com
 * Copyright (c) 2025-2026 Merchant Protocol LLC.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
/** @jest-environment node */
import { jest } from '@jest/globals';

const values = new Map<string, unknown>();
jest.unstable_mockModule('@pkg/agent/database/models/SullaSettingsModel', () => ({
  SullaSettingsModel: {
    get: jest.fn(async(key: string, fallback: unknown) => values.has(key) ? values.get(key) : fallback),
    set: jest.fn(async(key: string, value: unknown) => { values.set(key, value); }),
  },
}));
const settings = await import('../cloudSettings');

test('only personal data categories are exposed and recommended', async() => {
  expect(settings.RECOMMENDED_CLOUD_DATA_KINDS).toEqual(['usage', 'memory', 'conversations', 'files']);
  expect(Object.keys(settings.CLOUD_SETTING_KEYS)).toEqual(['enabled', 'usage', 'memory', 'conversations', 'files', 'vault', 'remoteAccess']);
  expect(settings.recommendedCloudPreferencesPatch()).toEqual({ enabled: true, usage: true, memory: true, conversations: true, files: true });
});

test('legacy marketplace values are ignored without changing personal settings', async() => {
  values.set('cloudSyncWorkflows', true);
  values.set('cloudSyncSkills', true);
  values.set('cloudSyncMemory', false);
  values.set('cloudSyncFiles', true);
  const before = await settings.getCloudPreferences();
  expect(before).toMatchObject({ memory: false, files: true });
  expect(before).not.toHaveProperty('workflows');
  expect(before).not.toHaveProperty('skills');
  await settings.setCloudPreferences({ workflows: true, skills: false } as any);
  expect(await settings.getCloudPreferences()).toMatchObject({ memory: false, files: true });
  expect(values.get('cloudSyncWorkflows')).toBe(true);
});

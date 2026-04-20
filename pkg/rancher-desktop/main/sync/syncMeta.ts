/**
 * Sync cursor storage — uses SullaSettingsModel as a lightweight key-value
 * store so we don't need a dedicated db_meta table. Mobile keeps the same
 * concept in its own db_meta table; functionally identical.
 */

import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';

const LAST_SEQ_KEY = 'claudeSyncLastSeq';

export async function getLastSeq(): Promise<number> {
  const raw = await SullaSettingsModel.get(LAST_SEQ_KEY, '0');
  const parsed = parseInt(String(raw ?? '0'), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function setLastSeq(seq: number): Promise<void> {
  await SullaSettingsModel.set(LAST_SEQ_KEY, String(seq), 'string');
}

export async function resetLastSeq(): Promise<void> {
  await setLastSeq(0);
}

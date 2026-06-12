/**
 * ObservationsImportSeeder
 *
 * One-time migration of the legacy serialised `observationalMemory` JSON array
 * from sulla_settings into the new `observations` Postgres table (migration 0028).
 *
 * Safe to run multiple times — importLegacy uses ON CONFLICT DO NOTHING.
 * The old serialised key is intentionally left in place after import.
 */

import { parseJson } from '../../services/JsonParseService';
import { ObservationsModel } from '../models/ObservationsModel';
import { SullaSettingsModel } from '../models/SullaSettingsModel';

async function initialize(): Promise<void> {
  console.log('[ObservationsImportSeeder] Starting legacy observation import...');

  const raw = await SullaSettingsModel.get('observationalMemory', '[]');
  let entries: any[] = [];

  try {
    const parsed = parseJson(raw);
    if (Array.isArray(parsed)) {
      entries = parsed;
    }
  } catch (err) {
    console.warn('[ObservationsImportSeeder] Could not parse observationalMemory — nothing to import:', err);
    return;
  }

  if (entries.length === 0) {
    console.log('[ObservationsImportSeeder] No legacy observations found — nothing to import');
    return;
  }

  const imported = await ObservationsModel.importLegacy(entries);
  console.log(`[ObservationsImportSeeder] Imported ${ imported } of ${ entries.length } observations`);
}

export { initialize };

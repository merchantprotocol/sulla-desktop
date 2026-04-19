import { integrations } from '../../integrations/catalog';
import { IntegrationValueModel } from '../models/IntegrationValueModel';
import { SullaSettingsModel } from '../models/SullaSettingsModel';

/**
 * Migrates remote LLM provider credentials that were saved to SullaSettingsModel
 * during first-run (before the database existed) into the IntegrationService
 * integration_values table.
 *
 * First-run keys follow the pattern:  firstrun_<providerId>_<propertyKey>
 * e.g. firstrun_grok_api_key, firstrun_grok_model
 *
 * Also picks up legacy flat keys (remoteProvider, remoteApiKey, remoteModel)
 * for users who configured a remote model before the integration system existed.
 */

const ACCOUNT_ID = 'default';

async function initialize(): Promise<void> {
  console.log('[FirstRunRemoteCredentialsSeeder] Starting...');

  // --- 1. Check for first-run prefixed credentials ---
  const firstrunProvider = await SullaSettingsModel.get('firstrun_remoteProvider', '');

  if (firstrunProvider) {
    const integration = integrations[firstrunProvider];
    if (integration) {
      console.log(`[FirstRunRemoteCredentialsSeeder] Found first-run credentials for provider: ${ firstrunProvider }`);

      // Migrate each property from SullaSettingsModel into integration_values
      for (const prop of (integration.properties || [])) {
        const value = await SullaSettingsModel.get(`firstrun_${ firstrunProvider }_${ prop.key }`, '');
        if (value?.trim()) {
          await IntegrationValueModel.upsert(firstrunProvider, ACCOUNT_ID, prop.key, value);
          console.log(`[FirstRunRemoteCredentialsSeeder]   Migrated ${ prop.key } for ${ firstrunProvider }`);
        }
      }

      // Set account label
      await IntegrationValueModel.upsert(firstrunProvider, ACCOUNT_ID, 'account_label', integration.name);

      // Mark as connected
      await IntegrationValueModel.upsert(firstrunProvider, ACCOUNT_ID, 'connection_status', 'true');

      // Set as default account
      await IntegrationValueModel.setDefaultAccount(firstrunProvider, ACCOUNT_ID);

      console.log(`[FirstRunRemoteCredentialsSeeder] Completed migration for ${ firstrunProvider }`);
      return; // first-run prefixed keys take priority
    }
  }

  // --- 2. Fallback: check for legacy flat keys (remoteProvider + remoteApiKey + remoteModel) ---
  const legacyProvider = await SullaSettingsModel.get('remoteProvider', '');
  const legacyApiKey = await SullaSettingsModel.get('remoteApiKey', '');
  const legacyModel = await SullaSettingsModel.get('remoteModel', '');

  if (legacyProvider && legacyApiKey && integrations[legacyProvider]) {
    // Check if this integration is already connected (another seeder may have handled it)
    const existing = await IntegrationValueModel.findByKey(legacyProvider, ACCOUNT_ID, 'api_key');
    if (existing) {
      console.log(`[FirstRunRemoteCredentialsSeeder] ${ legacyProvider } already has credentials — skipping legacy migration`);
      return;
    }

    console.log(`[FirstRunRemoteCredentialsSeeder] Migrating legacy credentials for: ${ legacyProvider }`);

    await IntegrationValueModel.upsert(legacyProvider, ACCOUNT_ID, 'api_key', legacyApiKey);

    if (legacyModel) {
      await IntegrationValueModel.upsert(legacyProvider, ACCOUNT_ID, 'model', legacyModel);
    }

    // Set account label
    const integration = integrations[legacyProvider];
    await IntegrationValueModel.upsert(legacyProvider, ACCOUNT_ID, 'account_label', integration.name);

    // Mark as connected
    await IntegrationValueModel.upsert(legacyProvider, ACCOUNT_ID, 'connection_status', 'true');

    // Set as default account
    await IntegrationValueModel.setDefaultAccount(legacyProvider, ACCOUNT_ID);

    console.log(`[FirstRunRemoteCredentialsSeeder] Completed legacy migration for ${ legacyProvider }`);
    return;
  }

  console.log('[FirstRunRemoteCredentialsSeeder] No first-run remote credentials found — nothing to migrate');
}

export { initialize };

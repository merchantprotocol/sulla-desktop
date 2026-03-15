// N8nUserSeeder.ts
// Seeds the n8n database with a user and API key for Sulla integration

import { N8nUserModel } from '../models/N8nUserModel';
import { N8nUserApiKeyModel } from '../models/N8nUserApiKeyModel';
import { SullaSettingsModel } from '../models/SullaSettingsModel';

async function initialize(): Promise<void> {
  console.log('[N8nUserSeeder] Starting...');

  console.log(`[N8nUserSeeder] Get or creating user:`);

  const allUsers = await N8nUserModel.all();
  console.log('[N8nUserSeeder] allUsers result:', allUsers.map(u => ({ id: u.attributes.id, email: u.attributes.email, roleSlug: u.attributes.roleSlug })));

  const globalOwnerUsers = await N8nUserModel.where('roleSlug', 'global:owner');
  console.log('[N8nUserSeeder] globalOwnerUsers result:', globalOwnerUsers.map(u => ({ id: u.attributes.id, email: u.attributes.email, roleSlug: u.attributes.roleSlug })));

  let user = allUsers.length > 0 ? allUsers[0] : null;

  if (user) {
    user.attributes.email = await N8nUserModel.getServiceAccountEmail();
    user.attributes.firstName = 'Sulla';
    user.attributes.lastName = 'Desktop';
    user.attributes.personalizationAnswers = {};
    user.attributes.settings = { userActivated: true };
    user.attributes.disabled = false;
    user.attributes.mfaEnabled = false;
    user.attributes.mfaSecret = '';
    user.attributes.mfaRecoveryCodes = '';
    user.attributes.lastActiveAt = new Date();
    user.attributes.roleSlug = 'global:owner';
    await user.setPassword(await N8nUserModel.getServiceAccountPassword());
    await user.save();

    await SullaSettingsModel.set('serviceAccountUserId', user.attributes.id, 'string');
    console.log('[N8nUserModel] Settings saved:', user.attributes.id);
  } else {
    user = await N8nUserModel.getOrCreateServiceAccount();
  }

  // Create the user with plain password - the model will hash it
  const apiKeyModel = await N8nUserApiKeyModel.getOrCreateServiceAccount(user.attributes.id);

  const serviceAccountApiKey = apiKeyModel.attributes.apiKey;
  await SullaSettingsModel.set('serviceAccountApiKey', serviceAccountApiKey, 'string');

  console.log(`[N8nUserSeeder] Created N8N User with ID: ${ user.attributes.id }`);
  console.log(`[N8nUserSeeder] Created N8N API key with ID: ${ apiKeyModel.attributes.id }`);
}

export { initialize };

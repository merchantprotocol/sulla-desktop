import type { ToolManifest } from '../registry';

export const integrationsToolManifests: ToolManifest[] = [
  {
    name:        'integration_get_credentials',
    description: 'Retrieve the credentials and connection status for a specific integration. Shows all accounts if multiple exist, with the active account highlighted. Returns each credential property name, title, type, whether it is required, and its stored value.',
    category:    'integrations',
    schemaDef:   {
      integration_slug: { type: 'string', description: "The slug identifier of the integration (e.g. 'slack', 'github', 'n8n')" },
      account_id:       { type: 'string', optional: true, description: 'Optional account ID to get credentials for a specific account. Defaults to the active account.' },
      include_secrets:  { type: 'boolean', optional: true, description: 'When true, returns the full decrypted values for password/secret fields. Defaults to false, which masks sensitive values.' },
    },
    operationTypes: ['read'],
    loader:         () => import('./integration_get_credentials'),
  },
  {
    name:        'integration_is_enabled',
    description: 'Check whether a specific integration is enabled (connected). Returns the enabled status along with connection timestamps.',
    category:    'integrations',
    schemaDef:   {
      integration_slug: { type: 'string', description: "The slug identifier of the integration (e.g. 'slack', 'github', 'n8n')" },
    },
    operationTypes: ['read'],
    loader:         () => import('./integration_is_enabled'),
  },
  {
    name:        'list_integration_accounts',
    description: 'List all accounts configured for an integration. Shows account labels, connection status, and which account is currently active. Use this when an integration has multiple accounts (e.g. multiple Gmail accounts).',
    category:    'integrations',
    schemaDef:   {
      integration_slug: { type: 'string', description: "The slug identifier of the integration (e.g. 'gmail', 'slack')" },
    },
    operationTypes: ['read'],
    loader:         () => import('./list_integration_accounts'),
  },
  {
    name:        'set_active_integration_account',
    description: 'Set which account is active for an integration. After setting the active account, all subsequent tool calls for that integration will automatically use its credentials. Use list_integration_accounts first to see available accounts.',
    category:    'integrations',
    schemaDef:   {
      integration_slug: { type: 'string', description: "The slug identifier of the integration (e.g. 'gmail', 'slack')" },
      account_id:       { type: 'string', description: 'The account_id to set as active (from list_integration_accounts)' },
    },
    operationTypes: ['update'],
    loader:         () => import('./set_active_integration_account'),
  },
];

import type { ToolManifest } from '../registry';

/**
 * Settings tools — the single agent-facing path into SullaSettingsModel.
 * Product code already uses the model; these tools exist so agents do
 * the same instead of hitting the Redis `sulla_settings` hash directly.
 */
export const settingsToolManifests: ToolManifest[] = [
  {
    name:        'settings_get',
    description: 'Read a Sulla Desktop setting through SullaSettingsModel (Redis cache → Postgres → file fallback). Use this instead of redis_hget on sulla_settings — raw Redis reads of that hash are blocked.',
    category:    'settings',
    schemaDef:   {
      property: { type: 'string', description: 'Setting key (e.g. heartbeatEnabled, remoteProvider).' },
      default:  { type: 'string', optional: true, description: 'Value to return if the setting is unset.' },
    },
    operationTypes: ['read'],
    loader:         () => import('./get'),
  },
  {
    name:        'settings_set',
    description: 'Write a Sulla Desktop setting through SullaSettingsModel so Postgres and the Redis cache stay in sync. Use this instead of redis_hset on sulla_settings — raw Redis writes of that hash are blocked.',
    category:    'settings',
    schemaDef:   {
      property: { type: 'string', description: 'Setting key.' },
      value:    { type: 'string', description: 'Value to store. Booleans/numbers/json are accepted and cast via the optional cast field.' },
      cast:     { type: 'string', optional: true, description: 'Optional cast: string | number | boolean | json | array. Defaults to typeof value.' },
    },
    operationTypes: ['update'],
    loader:         () => import('./set'),
  },
];

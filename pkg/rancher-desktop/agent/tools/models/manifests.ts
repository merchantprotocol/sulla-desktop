import type { ToolManifest } from '../registry';

export const modelsToolManifests: ToolManifest[] = [
  {
    name:        'models_providers',
    description: 'List AI model providers, whether each is connected/on or disconnected/off, whether any required CLI is installed in the Sulla VM, and whether Sulla can use it.',
    category:    'models',
    schemaDef:   {
      include_disconnected: { type: 'boolean', optional: true, description: 'Include disconnected/off providers. Defaults to true.' },
    },
    operationTypes: ['read'],
    loader:         () => import('./providers'),
  },
  {
    name:        'models_list',
    description: 'List models available for one provider using Sulla provider discovery, with static catalog fallback when live discovery is unavailable.',
    category:    'models',
    schemaDef:   {
      provider: { type: 'string', description: 'Provider id, e.g. codex, claude-code, grok, openai, anthropic, google, cohere.' },
    },
    operationTypes: ['read'],
    loader:         () => import('./list'),
  },
  {
    name:        'models_usage',
    description: 'Read locally tracked model usage captured by Sulla. Supports Codex and Claude Code rolling usage today; other provider billing APIs are not queried.',
    category:    'models',
    schemaDef:   {
      provider: { type: 'string', optional: true, description: 'Optional provider filter, e.g. codex or claude-code.' },
      model:    { type: 'string', optional: true, description: 'Optional exact model id filter.' },
      hours:    { type: 'number', optional: true, description: 'Lookback window in hours. Defaults to 24.' },
    },
    operationTypes: ['read'],
    loader:         () => import('./usage'),
  },
];

import type { ToolManifest } from '../registry';

export const bridgeToolManifests: ToolManifest[] = [
  {
    name:        'update_human_presence',
    description: 'Update the human presence state in Redis. Call this to inform other agents about what the human is currently viewing, doing, or whether they are available.',
    category:    'bridge',
    schemaDef:   {
      available:        { type: 'boolean', optional: true, default: true, description: 'Whether the human is currently available for interaction.' },
      current_view:     { type: 'string', optional: true, description: 'What the human is currently viewing (e.g., "Agent Chat", "Settings", "Integrations", "Extensions").' },
      current_activity: { type: 'string', optional: true, description: 'What the human is currently doing (e.g., "chatting with agent", "configuring integrations", "idle").' },
      active_channel:   { type: 'string', optional: true, description: 'The channel the human is currently listening on.' },
    },
    operationTypes: ['update'],
    loader:         () => import('./update_human_presence'),
  },
  {
    name:           'get_human_presence',
    description:    'Read the current human presence state from Redis. Returns whether the human is available, what they are viewing, their activity, and how long since they were last seen.',
    category:       'bridge',
    schemaDef:      {},
    operationTypes: ['read'],
    loader:         () => import('./get_human_presence'),
  },
];

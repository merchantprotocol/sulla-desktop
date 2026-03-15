import type { ToolManifest } from '../registry';

export const slackToolManifests: ToolManifest[] = [
  {
    name:        'slack_connection_health',
    description: 'Check Slack integration health and auto-reinitialize if disconnected/unhealthy.',
    category:    'slack',
    schemaDef:   {
      reinitializeIfNeeded: {
        type:        'boolean',
        optional:    true,
        description: 'When true (default), invalidate and reinitialize Slack if missing or unhealthy.',
      },
      recoveryAttempts: {
        type:        'number',
        optional:    true,
        description: 'Number of reconnect attempts when reinitializing (default: 3).',
      },
      recoveryDelayMs: {
        type:        'number',
        optional:    true,
        description: 'Delay in ms between reconnect attempts (default: 2000).',
      },
      validateAuth: {
        type:        'boolean',
        optional:    true,
        description: 'When true (default), run Slack auth.test as a live health check.',
      },
      validateDataPull: {
        type:        'boolean',
        optional:    true,
        description: 'When true (default), run users.list(limit=1) to verify real Slack data read access.',
      },
    },
    operationTypes: ['read'],
    loader:         () => import('./slack_connection_health'),
  },
  {
    name:        'slack_search_users',
    description: 'Search Slack users by username, real name, display name, or email.',
    category:    'slack',
    schemaDef:   {
      query: { type: 'string', description: 'Search query for Slack users' },
      limit: { type: 'number', optional: true, description: 'Maximum number of users to return (default: 10)' },
    },
    operationTypes: ['read'],
    loader:         () => import('./slack_search_users'),
  },
  {
    name:        'slack_send_message',
    description: 'Send a new message to a Slack channel.',
    category:    'slack',
    schemaDef:   {
      channel: { type: 'string', description: 'Channel ID where the message will be posted' },
      text:    { type: 'string', description: 'Message text to post' },
    },
    operationTypes: ['read'],
    loader:         () => import('./slack_send_message'),
  },
  {
    name:        'slack_thread',
    description: 'Get replies in a Slack thread.',
    category:    'slack',
    schemaDef:   {
      channel: { type: 'string', description: 'Channel ID where the thread is' },
      ts:      { type: 'string', description: 'Timestamp of the parent message' },
    },
    operationTypes: ['read'],
    loader:         () => import('./slack_thread'),
  },
  {
    name:        'slack_unreact',
    description: 'Remove a reaction emoji from a Slack message.',
    category:    'slack',
    schemaDef:   {
      channel:  { type: 'string', description: 'Channel ID where the message is' },
      ts:       { type: 'string', description: 'Timestamp of the message' },
      reaction: { type: 'string', description: 'Reaction emoji name to remove (without colons)' },
    },
    operationTypes: ['read'],
    loader:         () => import('./slack_unreact'),
  },
  {
    name:        'slack_update',
    description: 'Update an existing Slack message.',
    category:    'slack',
    schemaDef:   {
      channel: { type: 'string', description: 'Channel ID where the message is' },
      ts:      { type: 'string', description: 'Timestamp of the message to update' },
      text:    { type: 'string', description: 'New message text' },
    },
    operationTypes: ['read'],
    loader:         () => import('./slack_update'),
  },
  {
    name:        'slack_user',
    description: 'Get information about a Slack user.',
    category:    'slack',
    schemaDef:   {
      userId: { type: 'string', description: 'User ID to get info for' },
    },
    operationTypes: ['read'],
    loader:         () => import('./slack_user'),
  },
];

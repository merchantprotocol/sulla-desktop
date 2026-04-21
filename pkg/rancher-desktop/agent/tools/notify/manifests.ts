import type { ToolManifest } from '../registry';

/**
 * Notification tools — send desktop notifications to the user.
 * Separate from `browser/*` so the agent doesn't associate UI notifications
 * with web-page state.
 */
export const notifyToolManifests: ToolManifest[] = [
  {
    name:        'notify_user',
    description: 'Send a desktop notification to alert the user. Use when an async task completes, an error needs attention, or you want to communicate while the user is in another app.',
    category:    'notify',
    schemaDef:   {
      title:   { type: 'string', description: 'Notification title (short, attention-grabbing).' },
      message: { type: 'string', description: 'Notification body text with details.' },
      id:      { type: 'string', optional: true, description: 'Optional notification ID. Auto-generated if omitted.' },
      silent:  { type: 'boolean', optional: true, description: 'If true, suppress the notification sound. Default false.' },
    },
    operationTypes: ['execute'],
    loader:         () => import('./notify_user'),
  },
];

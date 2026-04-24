import type { ToolManifest } from '../registry';

/**
 * Notification tools — send desktop / mobile notifications, query history.
 */
export const notifyToolManifests: ToolManifest[] = [
  {
    name:        'notify_user',
    description: 'Send a notification to the user. Default target is "desktop" (native macOS / Notification Center). Pass targets:["mobile"] to push to the paired phone via the Sulla Cloud relay, or targets:["desktop","mobile"] to fan out. Every call is logged to `notifications` — query via notify/history.',
    category:    'notify',
    schemaDef:   {
      title:   { type: 'string', description: 'Notification title (short, attention-grabbing).' },
      message: { type: 'string', description: 'Notification body text with details.' },
      targets: { type: 'array',  optional: true, description: 'Where to deliver: ["desktop"] (default), ["mobile"], or ["desktop","mobile"].' },
      id:      { type: 'string', optional: true, description: 'Optional notification ID. Auto-generated if omitted.' },
      silent:  { type: 'boolean', optional: true, description: 'If true, suppress the notification sound. Default false.' },
    },
    operationTypes: ['execute'],
    loader:         () => import('./notify_user'),
  },
  {
    name:        'history',
    description: 'Read the notification history. Every notify_user call writes a row with title, message, targets, delivered flag, and any error. Filter by target ("desktop" | "mobile"), only_failures, and/or since (ISO timestamp).',
    category:    'notify',
    schemaDef:   {
      limit:         { type: 'number',  optional: true, description: 'Max rows to return (default 50, cap 200).' },
      target:        { type: 'string',  optional: true, description: 'Filter to one target: "desktop" or "mobile".' },
      only_failures: { type: 'boolean', optional: true, description: 'If true, return only rows where delivered=false.' },
      since:         { type: 'string',  optional: true, description: 'ISO-8601 timestamp — return only rows at/after this time.' },
    },
    operationTypes: ['read'],
    loader:         () => import('./notify_history'),
  },
];

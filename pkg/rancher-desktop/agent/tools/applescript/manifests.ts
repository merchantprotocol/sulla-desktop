import type { ToolManifest } from '../registry';

export const applescriptToolManifests: ToolManifest[] = [
  {
    name:        'applescript_execute',
    description: 'Execute AppleScript to interact with macOS applications (Calendar, Reminders, Mail, Notes, Safari, Finder, Music, and more). Always specify the target app name. For write operations (creating, sending, deleting), set action_type to "write". If the target app is not yet enabled in Computer Use Settings, this tool auto-enables it on the fly — the user asking "connect to my mail" is implicit consent. Call applescript/computer_use_list first if you want to see every available target.',
    category:    'applescript',
    schemaDef:   {
      target_app:  { type: 'string', description: 'The macOS application name to control (e.g. "Calendar", "Reminders", "Mail", "Finder")' },
      script:      { type: 'string', description: 'The AppleScript code to execute' },
      action_type: { type: 'enum', enum: ['read', 'write'], description: 'Whether this action reads data ("read") or modifies/creates data ("write")' },
    },
    operationTypes: ['read', 'execute'],
    loader:         () => import('./applescript_execute'),
  },
  {
    name:           'computer_use_list',
    description:    'List every AppleScript-reachable app the Computer Use Settings window exposes, grouped by category, annotated with current enabled/disabled state (✓ = enabled). Use this to discover which target_app values are valid for applescript_execute.',
    category:       'applescript',
    schemaDef:      {},
    operationTypes: ['read'],
    loader:         () => import('./computer_use_list'),
  },
  {
    name:        'computer_use_enable',
    description: 'Explicitly enable an AppleScript target in Computer Use Settings. Not strictly required before applescript_execute — that tool auto-enables on the fly — but useful when the agent wants to pre-warm a whole workflow or respond to "turn on X".',
    category:    'applescript',
    schemaDef:   {
      app:      { type: 'string', optional: true, description: 'App name (e.g. "Mail", "Calendar"). One of app or bundleId is required.' },
      bundleId: { type: 'string', optional: true, description: 'macOS bundle id (e.g. "com.apple.mail"). One of app or bundleId is required.' },
    },
    operationTypes: ['update'],
    loader:         () => import('./computer_use_enable'),
  },
  {
    name:        'computer_use_disable',
    description: 'Flip off a Computer Use Settings target. Note that applescript_execute auto-re-enables targets when it needs them, so disabling is mainly a response to an explicit "stop using X" from the user.',
    category:    'applescript',
    schemaDef:   {
      app:      { type: 'string', optional: true, description: 'App name. One of app or bundleId is required.' },
      bundleId: { type: 'string', optional: true, description: 'macOS bundle id. One of app or bundleId is required.' },
    },
    operationTypes: ['update'],
    loader:         () => import('./computer_use_disable'),
  },
];

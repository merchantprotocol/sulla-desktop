import type { ToolManifest } from '../registry';

export const applescriptToolManifests: ToolManifest[] = [
  {
    name:        'applescript_execute',
    description: 'Execute AppleScript to interact with macOS applications the user has enabled in Computer Use Settings. Use this to read data from or perform actions in apps like Calendar, Reminders, Mail, Notes, Safari, Finder, Music, and more. Always specify the target app name. For write operations (creating, sending, deleting), set action_type to "write". The script will only run if the user has enabled the target app.',
    category:    'applescript',
    schemaDef:   {
      target_app:  { type: 'string', description: 'The macOS application name to control (e.g. "Calendar", "Reminders", "Mail", "Finder")' },
      script:      { type: 'string', description: 'The AppleScript code to execute' },
      action_type: { type: 'enum', enum: ['read', 'write'], description: 'Whether this action reads data ("read") or modifies/creates data ("write")' },
    },
    operationTypes: ['read', 'execute'],
    loader:         () => import('./applescript_execute'),
  },
];

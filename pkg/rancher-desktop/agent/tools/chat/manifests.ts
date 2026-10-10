import type { ToolManifest } from '../registry';

export const chatToolManifests: ToolManifest[] = [
  {
    name:        'set_heartbeat',
    description: 'Set the heartbeat for the current chat tab only. Use intervalMinutes=0 to turn it off. The timer never interrupts an in-flight run; one pending beat is delivered when the thread becomes idle.',
    category:    'chat',
    schemaDef:   {
      intervalMinutes: { type: 'number', description: 'Minutes between beats. Use 0 to turn this chat heartbeat off.' },
      message:         { type: 'string', optional: true, description: 'Message delivered to this chat on every beat. Keeps the current/default message when omitted.' },
    },
    operationTypes: ['update'],
    loader:         () => import('./set_heartbeat'),
  },
];

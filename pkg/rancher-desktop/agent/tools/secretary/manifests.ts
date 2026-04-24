import type { ToolManifest } from '../registry';

export const secretaryToolManifests: ToolManifest[] = [
  {
    name:        'start',
    description: 'Start Secretary Mode — opens (or focuses) a Secretary tab and auto-begins the listening session. Use when the user asks to "start taking notes", "enter secretary mode", "listen to my meeting", etc. Idempotent — reports "already listening" if a session is active. Requires microphone permission.',
    category:    'secretary',
    schemaDef:   {},
    operationTypes: ['execute'],
    loader:         () => import('./start'),
  },
  {
    name:        'stop',
    description: 'Stop Secretary Mode — ends the active listening session. Use when the user asks to "stop taking notes", "end secretary mode", "stop listening". No-op if not currently listening.',
    category:    'secretary',
    schemaDef:   {},
    operationTypes: ['execute'],
    loader:         () => import('./stop'),
  },
  {
    name:        'status',
    description: 'Check whether Secretary Mode is currently listening. Returns JSON { listening: boolean, tabId: string | null }. Use before start/stop if you need to condition on current state.',
    category:    'secretary',
    schemaDef:   {},
    operationTypes: ['read'],
    loader:         () => import('./status'),
  },
];

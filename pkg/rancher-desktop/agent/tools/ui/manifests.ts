import type { ToolManifest } from '../registry';

export const uiToolManifests: ToolManifest[] = [
  {
    name:        'open_tab',
    description: 'Open or focus a built-in Sulla Desktop view (marketplace, vault, integrations, routines, history, secretary, chat, document, browser). Use this when the user asks to "open" or "show me" a section of the app. For external URLs or extension web UIs (e.g. Twenty CRM at localhost:30207), use browser/tab instead.',
    category:    'ui',
    schemaDef:   {
      mode: {
        type:        'string',
        optional:    true,
        description: 'Built-in view to open. One of: marketplace, vault, integrations, routines, history, secretary, chat, document, browser, welcome.',
      },
      url: {
        type:        'string',
        optional:    true,
        description: 'Alternative to mode — opens a raw browser tab on the given URL inside Sulla Desktop.',
      },
    },
    operationTypes: ['execute'],
    loader:         () => import('./open_tab'),
  },
];

import type { ToolManifest } from '../registry';

export const extensionsToolManifests: ToolManifest[] = [
  {
    name:        'list_extension_catalog',
    description: 'List all available extensions from the Sulla marketplace catalog. Optionally filter by category or search query.',
    category:    'extensions',
    schemaDef:   {
      category: { type: 'string', optional: true, description: "Filter by category (e.g. 'productivity', 'media', 'email', 'security', 'development')" },
      query:    { type: 'string', optional: true, description: 'Search query to filter by name, description, or publisher' },
    },
    operationTypes: ['read'],
    loader:         () => import('./list_catalog'),
  },
  {
    name:           'list_installed_extensions',
    description:    'List all currently installed extensions with their versions, URLs, and upgrade status.',
    category:       'extensions',
    schemaDef:      {},
    operationTypes: ['read'],
    loader:         () => import('./list_installed'),
  },
  {
    name:        'install_extension',
    description: 'Install an extension from the marketplace. Provide the extension ID in slug:version format (e.g. "docker.io/sulla-ai/stirling-pdf:2026.02"). The extension will be started automatically after installation.',
    category:    'extensions',
    schemaDef:   {
      id: { type: 'string', description: "Extension ID in slug:version format (e.g. 'docker.io/sulla-ai/stirling-pdf:2026.02')" },
    },
    operationTypes: ['create', 'execute'],
    loader:         () => import('./install_extension'),
  },
  {
    name:        'uninstall_extension',
    description: 'Uninstall an installed extension. By default preserves the data/ directory so user data survives reinstall. Set deleteData to true to remove everything.',
    category:    'extensions',
    schemaDef:   {
      id:         { type: 'string', description: "Extension ID (e.g. 'docker.io/sulla-ai/stirling-pdf')" },
      deleteData: { type: 'boolean', optional: true, description: 'If true, also delete the persistent data/ directory. Default: false (data preserved).' },
    },
    operationTypes: ['delete', 'execute'],
    loader:         () => import('./uninstall_extension'),
  },
];

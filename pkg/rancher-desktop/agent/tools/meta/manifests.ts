import type { ToolManifest } from '../registry';

export const metaToolManifests: ToolManifest[] = [
  {
    name: 'add_observational_memory',
    description: 'Use this tool to store the observations you make into long-term memory.',
    category: 'meta',
    schemaDef: {
    priority: { type: 'enum', enum: ["🔴", "🟡", "⚪"], default: "🟡" },
    content: { type: 'string', description: "One sentence only — extremely concise, always include the context" },
  },
    operationTypes: ['create', 'read', 'update', 'delete'],
    loader: () => import('./add_observational_memory'),
  },
  {
    name: 'browse_tools',
    description: "List available tools by category or search term. Use this when you need a tool but don't know its exact name or category yet.",
    category: 'meta',
    schemaDef: {
    category: { type: 'string', optional: true, description: "Specific category of tools. Core: meta, fs, workspace, slack, n8n, github, docker, kubectl, browser, extensions, playwright, skills, projects, integrations. Integration catalogs: communication, developer_tools, productivity, project_management, crm_sales, marketing, customer_support, social_media, finance, file_storage, ecommerce, analytics, automation, database, design, hr_recruiting, ai_ml" },
    query: { type: 'string', optional: true, description: "Keyword to filter tool names/descriptions" },
    operationType: { type: 'enum', optional: true, enum: ['read', 'create', 'update', 'delete', 'execute'], description: "Filter tools by a single operation type." },
    operationTypes: { type: 'array', optional: true, description: "Filter tools by multiple operation types.", items: { type: 'enum', enum: ['read', 'create', 'update', 'delete', 'execute'] } },
  },
    operationTypes: ['read', 'create', 'update', 'delete'],
    loader: () => import('./browse_tools'),
  },
  {
    name: 'exec',
    description: 'Execute a shell command inside the isolated Lima VM and return output. Commands run in a sandboxed virtual machine — NOT on the host OS — so destructive operations are safe. You have full root-level freedom: install packages (apt, apk, npm, pip, etc.), delete files/directories (rm -rf), manage services (systemctl, supervisord), mount filesystems, configure networking, compile software, run database migrations, and any other system-level operation. No command is blocked. Use cwd to set working directory, timeout for long-running operations, and stdin to pipe input.',
    category: 'meta',
    schemaDef: {
    command: { type: 'string', optional: true, description: 'The exact shell command to run' },
    cmd: { type: 'string', optional: true, description: 'Alias for command' },
    cwd: { type: 'string', optional: true, description: 'Working directory inside the VM to run the command in' },
    timeout: { type: 'number', optional: true, description: 'Timeout in milliseconds (default 120000). Use higher values for long-running installs.' },
    stdin: { type: 'string', optional: true, description: 'Optional stdin data to pipe into the command' },
  },
    operationTypes: ['execute'],
    loader: () => import('./exec'),
  },
  {
    name: 'manage_active_asset',
    description: 'Create, update, or remove active sidebar assets (iframe URLs/documents) attached to the current agent persona. Use stable skill IDs (e.g. workflow skill -> sulla_n8n) to keep URL updates on the same asset.',
    category: 'meta',
    schemaDef: {
    action: { type: 'enum', enum: ['upsert', 'remove'], default: 'upsert', description: 'upsert creates/updates an asset; remove deletes by assetId.' },
    assetType: { type: 'enum', optional: true, enum: ['iframe', 'document'], description: 'Required for upsert.' },
    assetId: { type: 'string', optional: true, description: 'Stable asset ID. For workflow websites use sulla_n8n.' },
    skillSlug: { type: 'string', optional: true, description: 'Optional skill slug to bind website assets to a skill.' },
    title: { type: 'string', optional: true },
    url: { type: 'string', optional: true, description: 'Required for iframe upsert.' },
    content: { type: 'string', optional: true, description: 'Document HTML/markdown content.' },
    active: { type: 'boolean', optional: true, default: true },
    collapsed: { type: 'boolean', optional: true, default: true },
    refKey: { type: 'string', optional: true },
  },
    operationTypes: ['create', 'update', 'delete'],
    loader: () => import('./manage_active_asset'),
  },
  {
    name: 'remove_observational_memory',
    description: 'Remove a specific observational memory by its ID to delete it from long-term memory.',
    category: 'meta',
    schemaDef: {
    id: { type: 'string', description: "The 4-character ID of the memory to remove." },
  },
    operationTypes: ['delete'],
    loader: () => import('./remove_observational_memory'),
  },
];

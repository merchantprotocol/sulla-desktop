import type { ToolManifest } from '../registry';

export const chromeToolManifests: ToolManifest[] = [
  {
    name:        'manage_cookies',
    description: 'Read, set, or delete browser cookies. Use this to debug auth issues, check login state, inspect session tokens, or manage cookies across integrated services (Twenty CRM, N8N, etc.).',
    category:    'chrome',
    schemaDef:   {
      action: {
        type:        'enum',
        enum:        ['get', 'getAll', 'set', 'remove'],
        description: 'The cookie operation: get (single), getAll (filtered list), set, or remove.',
      },
      url: {
        type:        'string',
        optional:    true,
        description: 'The URL the cookie belongs to. Required for get, set, remove. Optional filter for getAll.',
      },
      name: {
        type:        'string',
        optional:    true,
        description: 'Cookie name. Required for get, set, remove.',
      },
      value: {
        type:        'string',
        optional:    true,
        description: 'Cookie value. Required for set.',
      },
      domain: {
        type:        'string',
        optional:    true,
        description: 'Cookie domain. Optional for set and getAll filter.',
      },
      path: {
        type:        'string',
        optional:    true,
        description: 'Cookie path. Defaults to "/" for set.',
      },
      secure: {
        type:        'boolean',
        optional:    true,
        description: 'Whether the cookie requires HTTPS.',
      },
      httpOnly: {
        type:        'boolean',
        optional:    true,
        description: 'Whether the cookie is HTTP-only (not accessible via JS).',
      },
      expirationDate: {
        type:        'number',
        optional:    true,
        description: 'Expiration as seconds since epoch. Omit for session cookie.',
      },
    },
    operationTypes: ['read', 'create', 'delete'],
    loader:         () => import('./manage_cookies'),
  },

  {
    name:        'background_browse',
    description: 'Browse the web in a hidden tab without disrupting the user\'s visible browser. Open pages, read content, navigate, and close — all in the background. Ideal for research, checking URLs, or scraping data while the user works.',
    category:    'chrome',
    schemaDef:   {
      action: {
        type:        'enum',
        enum:        ['open', 'read', 'navigate', 'close', 'list'],
        description: 'open: create hidden tab and read content. read: read from existing hidden tab. navigate: load new URL. close: destroy hidden tab. list: show all hidden tabs.',
      },
      url: {
        type:        'string',
        optional:    true,
        description: 'URL to open or navigate to. Required for open and navigate.',
      },
      tabId: {
        type:        'string',
        optional:    true,
        description: 'ID of an existing hidden tab. Required for read, navigate, close.',
      },
      waitMs: {
        type:        'number',
        optional:    true,
        description: 'Milliseconds to wait for page load before reading content. Default 3000.',
      },
      code: {
        type:        'string',
        optional:    true,
        description: 'Custom JavaScript to execute instead of default content extraction. For read action.',
      },
    },
    operationTypes: ['read', 'execute'],
    loader:         () => import('./background_browse'),
  },

  {
    name:        'notify_user',
    description: 'Send a desktop notification to alert the user. Use when an async task completes, an error needs attention, or you want to communicate while the user is in another app.',
    category:    'chrome',
    schemaDef:   {
      title: {
        type:        'string',
        description: 'Notification title (short, attention-grabbing).',
      },
      message: {
        type:        'string',
        description: 'Notification body text with details.',
      },
      id: {
        type:        'string',
        optional:    true,
        description: 'Optional notification ID. Auto-generated if omitted.',
      },
      silent: {
        type:        'boolean',
        optional:    true,
        description: 'If true, suppress the notification sound. Default false.',
      },
    },
    operationTypes: ['execute'],
    loader:         () => import('./notify_user'),
  },

  {
    name:        'search_history',
    description: 'Search the user\'s browsing history by text query and/or time range. Find pages visited previously, check when a site was last accessed, or recall URLs the user looked at earlier.',
    category:    'chrome',
    schemaDef:   {
      query: {
        type:        'string',
        optional:    true,
        description: 'Text to search for in URLs and page titles. Leave empty to list recent history.',
      },
      maxResults: {
        type:        'number',
        optional:    true,
        description: 'Maximum results to return. Default 20.',
      },
      startTime: {
        type:        'number',
        optional:    true,
        description: 'Only return entries after this time (ms since epoch).',
      },
      endTime: {
        type:        'number',
        optional:    true,
        description: 'Only return entries before this time (ms since epoch).',
      },
    },
    operationTypes: ['read'],
    loader:         () => import('./search_history'),
  },

  {
    name:        'modify_history',
    description: 'Add, delete, or clear browsing history entries. Use to record researched URLs, remove sensitive entries, or clear history for privacy. Distinct from search_history (read-only) and search_conversations (chat/workflow history).',
    category:    'chrome',
    schemaDef:   {
      action: {
        type:        'enum',
        enum:        ['add', 'delete', 'deleteAll'],
        description: 'add: record a URL visit. delete: remove all entries for a URL. deleteAll: clear entire browsing history.',
      },
      url: {
        type:        'string',
        optional:    true,
        description: 'The URL to add or delete. Required for add and delete actions.',
      },
      title: {
        type:        'string',
        optional:    true,
        description: 'Page title for add action. Optional.',
      },
    },
    operationTypes: ['create', 'delete'],
    loader:         () => import('./modify_history'),
  },

  {
    name:        'search_conversations',
    description: 'Search past chat conversations, browser visits, and workflow executions. Find previous discussions by keyword, list recent activity, or retrieve details for a specific conversation by ID or thread ID. This searches the conversation history database — use search_history for browsing URL history.',
    category:    'chrome',
    schemaDef:   {
      action: {
        type:        'enum',
        enum:        ['search', 'recent', 'get'],
        description: 'search: full-text search by query. recent: list recent conversations. get: retrieve a specific conversation by id or threadId.',
      },
      query: {
        type:        'string',
        optional:    true,
        description: 'Search text to match against conversation titles and summaries. Required for search action.',
      },
      limit: {
        type:        'number',
        optional:    true,
        description: 'Max results for recent action. Default 20.',
      },
      type: {
        type:        'enum',
        enum:        ['chat', 'browser', 'workflow', 'graph'],
        optional:    true,
        description: 'Filter by conversation type. For recent action.',
      },
      id: {
        type:        'string',
        optional:    true,
        description: 'Conversation ID. For get action.',
      },
      threadId: {
        type:        'string',
        optional:    true,
        description: 'Thread ID. For get action (alternative to id).',
      },
    },
    operationTypes: ['read'],
    loader:         () => import('./search_conversations'),
  },

  {
    name:        'agent_storage',
    description: 'Persistent key-value store for agent state that survives across conversations. Store task progress, discovered user preferences, cached API responses, or any structured data. Backed by the database (Redis + PostgreSQL with file fallback).',
    category:    'chrome',
    schemaDef:   {
      action: {
        type:        'enum',
        enum:        ['get', 'set', 'remove'],
        description: 'get: retrieve values by key(s). set: store key-value pairs. remove: delete key(s).',
      },
      keys: {
        type:        'string',
        optional:    true,
        description: 'Key or comma-separated keys to get or remove. Omit to get all stored values.',
      },
      data: {
        type:        'object',
        optional:    true,
        description: 'Object of key-value pairs to store. Required for set action.',
      },
    },
    operationTypes: ['read', 'create', 'delete'],
    loader:         () => import('./agent_storage'),
  },

  {
    name:        'monitor_network',
    description: 'Monitor network requests for a duration. Capture all requests (with status codes) or watch for errors/failures. Useful for debugging API calls, checking if services are healthy, or understanding what network traffic a page generates.',
    category:    'chrome',
    schemaDef:   {
      action: {
        type:        'enum',
        enum:        ['capture', 'watch_errors'],
        description: 'capture: record all requests for the duration. watch_errors: only collect failed requests (network errors + HTTP 4xx/5xx).',
      },
      durationSeconds: {
        type:        'number',
        optional:    true,
        description: 'How long to monitor in seconds. Default 5 for capture, 10 for watch_errors.',
      },
      urlFilter: {
        type:        'string',
        optional:    true,
        description: 'Only capture requests whose URL contains this string. For capture action.',
      },
    },
    operationTypes: ['read'],
    loader:         () => import('./monitor_network'),
  },

  {
    name:        'schedule_alarm',
    description: 'Set, list, or clear named timers. Use for deferred checks ("check the deploy in 5 minutes"), periodic polling ("watch this every 2 minutes"), or simple reminders. Alarms fire in-process and do not survive app restarts.',
    category:    'chrome',
    schemaDef:   {
      action: {
        type:        'enum',
        enum:        ['create', 'get', 'list', 'clear', 'clearAll'],
        description: 'create: set a new alarm. get: check a specific alarm. list: show all. clear: cancel one. clearAll: cancel all.',
      },
      name: {
        type:        'string',
        optional:    true,
        description: 'Alarm name. Required for create, get, clear.',
      },
      delayInMinutes: {
        type:        'number',
        optional:    true,
        description: 'Minutes before the alarm fires (one-shot). For create.',
      },
      periodInMinutes: {
        type:        'number',
        optional:    true,
        description: 'Repeat interval in minutes. For create. Can combine with delayInMinutes.',
      },
      when: {
        type:        'number',
        optional:    true,
        description: 'Absolute fire time as ms since epoch. For create.',
      },
    },
    operationTypes: ['create', 'read', 'delete'],
    loader:         () => import('./schedule_alarm'),
  },
];

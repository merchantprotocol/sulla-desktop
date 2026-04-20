import type { ToolManifest } from '../registry';

/**
 * Browser tools — web page automation + browser-state APIs, consolidated from
 * the former `playwright` and `chrome` categories. The agent sees a single
 * `browser` namespace for everything browser-related so it can plan without
 * rediscovery.
 *
 * Opinionated return shape: tools that capture screenshots save them to disk
 * and return `{ screenshot: { assetId, path, width, height, bytes } }` — never
 * inline base64.
 */
export const browserToolManifests: ToolManifest[] = [
  // ── Tabs & navigation ────────────────────────────────────────────

  {
    name:        'tab',
    description: 'Open, navigate, or close a browser tab. When opening/navigating (action=upsert), the response already includes a dehydrated DOM snapshot of the loaded page — title, URL, interactive elements, and a summary — so you do NOT need to call `browser/snapshot` separately afterwards. Reuse the same assetId to navigate an existing tab to a new URL.',
    category:    'browser',
    schemaDef:   {
      action:    { type: 'enum', enum: ['upsert', 'remove'], default: 'upsert', description: 'upsert creates or navigates a tab; remove closes by assetId.' },
      assetType: { type: 'enum', optional: true, enum: ['browser', 'iframe', 'document'], description: 'Type of tab to open. Defaults to browser.' },
      assetId:   { type: 'string', optional: true, description: 'Stable asset ID. Reuse the same ID to update an existing tab.' },
      skillSlug: { type: 'string', optional: true, description: 'Optional skill slug to associate with the asset.' },
      title:     { type: 'string', optional: true },
      url:       { type: 'string', optional: true, description: 'Required when action=upsert and assetType=browser.' },
      content:   { type: 'string', optional: true, description: 'Document HTML/markdown content (for assetType=document).' },
      active:    { type: 'boolean', optional: true, default: true },
      collapsed: { type: 'boolean', optional: true, default: true },
      refKey:    { type: 'string', optional: true },
    },
    operationTypes: ['create', 'update', 'delete'],
    loader:         () => import('./tab'),
  },
  {
    name:           'list',
    description:    'List all open browser tabs with their assetId, URL, title, and status (ready/loading).',
    category:       'browser',
    schemaDef:      {},
    operationTypes: ['read'],
    loader:         () => import('./list'),
  },

  // ── Inspection (read page state) ─────────────────────────────────

  {
    name:        'snapshot',
    description: 'Re-read page state for an already-open tab. Default "dehydrated" mode returns a compressed DOM tree (~5k tokens) with interactive-element handles — ideal for planning. "full" mode adds reader-mode text and scroll position. Prefer using `browser/tab` (upsert) which already returns a dehydrated snapshot; call this when you need a fresh read after interactions.',
    category:    'browser',
    schemaDef:   {
      assetId: { type: 'string', optional: true, description: 'Target asset ID (omit for the currently active tab)' },
      mode:    { type: 'enum', optional: true, enum: ['full', 'dehydrated'], description: 'dehydrated (default) returns compressed DOM tree. full returns complete content with handles and reader text.' },
    },
    operationTypes: ['read'],
    loader:         () => import('./snapshot'),
  },
  {
    name:        'text',
    description: 'Get the readable text content of a tab with title, URL, and scroll position. Uses reader-mode extraction (strips nav, ads, boilerplate) with fallback to raw text.',
    category:    'browser',
    schemaDef:   {
      assetId: { type: 'string', optional: true, description: 'Target asset ID (omit for the currently active tab)' },
    },
    operationTypes: ['read'],
    loader:         () => import('./text'),
  },
  {
    name:        'form',
    description: 'Get a map of all visible form field values (inputs, textareas, selects) from a tab.',
    category:    'browser',
    schemaDef:   {
      assetId: { type: 'string', optional: true, description: 'Target asset ID (omit for the currently active tab)' },
    },
    operationTypes: ['read'],
    loader:         () => import('./form'),
  },
  {
    name:        'screenshot',
    description: 'Capture a visual screenshot of a tab. Image is saved to disk and the response returns a compact `{ screenshot: { assetId, path, width, height, bytes } }` reference — never inline base64. Use Read on the returned path to inspect the image visually. By default includes a coordinate grid so click_at/type_at coordinates are easy to pick. Set annotate=true to draw numbered boxes on interactive elements.',
    category:    'browser',
    schemaDef:   {
      assetId:  { type: 'string', optional: true, description: 'Target tab (omit for the active tab)' },
      grid:     { type: 'boolean', optional: true, description: 'Show coordinate grid overlay (default true)' },
      annotate: { type: 'boolean', optional: true, description: 'Draw numbered boxes on interactive elements (default false)' },
    },
    operationTypes: ['read'],
    loader:         () => import('./screenshot'),
  },

  // ── Interaction (DOM-handle based — preferred) ───────────────────

  {
    name:        'click',
    description: 'Click a button, link, or interactive element by handle. Handles come from the snapshot returned by browser/tab (upsert) or browser/snapshot — e.g. @btn-save, @link-home. Accepts a CSS selector as a fallback. If the click causes navigation, waits for the new page and returns its full state.',
    category:    'browser',
    schemaDef:   {
      handle:  { type: 'string', description: 'Element handle (@btn-<slug>, @link-<slug>, data-test-id, or CSS selector)' },
      assetId: { type: 'string', optional: true, description: 'Target asset ID (omit for the currently active tab)' },
    },
    operationTypes: ['execute'],
    loader:         () => import('./click'),
  },
  {
    name:        'fill',
    description: 'Set the value of a form field (input, textarea, select). If submit=true, presses Enter after to submit the form; if that triggers navigation, returns the full new page state. Use handles from the snapshot — e.g. @field-email, @field-username.',
    category:    'browser',
    schemaDef:   {
      handle:  { type: 'string', description: 'Field handle (@field-<id|name>) or element id/name' },
      value:   { type: 'string', description: 'Value to set' },
      submit:  { type: 'boolean', optional: true, description: 'Press Enter after filling to submit the form (default false)' },
      assetId: { type: 'string', optional: true, description: 'Target asset ID (omit for the currently active tab)' },
    },
    operationTypes: ['update'],
    loader:         () => import('./fill'),
  },
  {
    name:        'press_key',
    description: 'Press a key. Use for form submission (Enter), closing dialogs (Escape), navigating dropdowns (ArrowDown/ArrowUp), or tabbing between fields (Tab). Specify a handle to target a specific element, or omit to press on the focused element.',
    category:    'browser',
    schemaDef:   {
      key:     { type: 'string', description: 'Key to press: Enter, Escape, Tab, ArrowDown, ArrowUp, ArrowLeft, ArrowRight, Backspace, Space' },
      handle:  { type: 'string', optional: true, description: 'Element handle or CSS selector. Omit to target the focused element.' },
      assetId: { type: 'string', optional: true, description: 'Target asset ID (omit for the currently active tab)' },
    },
    operationTypes: ['execute'],
    loader:         () => import('./press_key'),
  },
  {
    name:        'scroll',
    description: 'Scroll a matching element into view using a CSS selector.',
    category:    'browser',
    schemaDef:   {
      selector: { type: 'string', description: 'CSS selector of the element to scroll into view' },
      assetId:  { type: 'string', optional: true, description: 'Target asset ID (omit for the currently active tab)' },
    },
    operationTypes: ['execute'],
    loader:         () => import('./scroll'),
  },
  {
    name:        'wait',
    description: 'Wait for a CSS selector to become visible. Useful after clicking a button to wait for new content to appear.',
    category:    'browser',
    schemaDef:   {
      selector: { type: 'string', description: 'CSS selector to wait for' },
      timeout:  { type: 'number', optional: true, default: 5000, description: 'Maximum wait in milliseconds (default 5000)' },
      assetId:  { type: 'string', optional: true, description: 'Target asset ID (omit for the currently active tab)' },
    },
    operationTypes: ['read'],
    loader:         () => import('./wait'),
  },

  // ── Interaction (pixel-coordinate — fallback when handles fail) ──

  {
    name:        'click_at',
    description: 'Click at pixel coordinates using trusted mouse events. Use `browser/screenshot` first to identify coordinates (grid on by default). After clicking, captures a screenshot to show the result. Use only when DOM handles cannot reach the target.',
    category:    'browser',
    schemaDef:   {
      x:            { type: 'number', description: 'X coordinate in pixels' },
      y:            { type: 'number', description: 'Y coordinate in pixels' },
      button:       { type: 'enum', optional: true, enum: ['left', 'right', 'middle'], description: 'Mouse button (default left)' },
      double_click: { type: 'boolean', optional: true, description: 'Double-click instead of single click' },
      assetId:      { type: 'string', optional: true, description: 'Target tab (omit for the active tab)' },
    },
    operationTypes: ['execute'],
    loader:         () => import('./click_at'),
  },
  {
    name:        'type_at',
    description: 'Click at coordinates to focus an element, then type text using trusted keyboard events. After typing, captures a screenshot. Set submit=true to press Enter after. Use for chat widgets, search boxes, or inputs that DOM-based `browser/fill` cannot reach.',
    category:    'browser',
    schemaDef:   {
      x:       { type: 'number', description: 'X coordinate to click for focus' },
      y:       { type: 'number', description: 'Y coordinate to click for focus' },
      text:    { type: 'string', description: 'Text to type' },
      submit:  { type: 'boolean', optional: true, description: 'Press Enter after typing (default false)' },
      assetId: { type: 'string', optional: true, description: 'Target tab (omit for the active tab)' },
    },
    operationTypes: ['execute'],
    loader:         () => import('./type_at'),
  },
  {
    name:        'hover',
    description: 'Move the mouse to coordinates without clicking. Triggers hover effects, dropdown menus, and tooltips. Shows a cursor at the position and captures a screenshot of the hover state.',
    category:    'browser',
    schemaDef:   {
      x:       { type: 'number', description: 'X coordinate in pixels' },
      y:       { type: 'number', description: 'Y coordinate in pixels' },
      assetId: { type: 'string', optional: true, description: 'Target tab (omit for the active tab)' },
    },
    operationTypes: ['execute'],
    loader:         () => import('./hover'),
  },

  // ── Escape hatch ─────────────────────────────────────────────────

  {
    name:        'exec',
    description: 'Execute arbitrary JavaScript in the page context with enhanced diagnostics. Returns result, console logs, timing, DOM mutation count, navigation detection, and page state. Captures window.__sulla.__log entries (cleared before execution). Use window.__sulla.waitFor(selector) and window.__sulla.waitForIdle() helpers for post-execution synchronization. Optionally capture a screenshot after. Use for anything the other browser tools cannot do.',
    category:    'browser',
    schemaDef:   {
      code:        { type: 'string', description: 'JavaScript code to execute in the page. The return value is sent back.' },
      screenshot:  { type: 'boolean', optional: true, description: 'Capture a screenshot after execution. Returns a compact reference under `screenshot` — image saved to disk, never inline base64.' },
      waitFor:     { type: 'string', optional: true, description: 'CSS selector to wait for after code execution (uses window.__sulla.waitFor if available).' },
      waitForIdle: { type: 'boolean', optional: true, description: 'Wait for the page to become idle after execution (uses window.__sulla.waitForIdle if available).' },
      timeout:     { type: 'number', optional: true, default: 30000, description: 'Maximum execution timeout in milliseconds (default 30000).' },
      assetId:     { type: 'string', optional: true, description: 'Target tab (omit for the active tab)' },
    },
    operationTypes: ['execute'],
    loader:         () => import('./exec'),
  },

  // ── Browser-state APIs (cookies, history, notifications, etc.) ───

  {
    name:        'manage_cookies',
    description: 'Read, set, or delete browser cookies. Use to debug auth issues, check login state, inspect session tokens, or manage cookies across integrated services (Twenty CRM, N8N, etc.).',
    category:    'browser',
    schemaDef:   {
      action:         { type: 'enum', enum: ['get', 'getAll', 'set', 'remove'], description: 'Cookie operation: get (single), getAll (filtered list), set, or remove.' },
      url:            { type: 'string', optional: true, description: 'URL the cookie belongs to. Required for get, set, remove. Optional filter for getAll.' },
      name:           { type: 'string', optional: true, description: 'Cookie name. Required for get, set, remove.' },
      value:          { type: 'string', optional: true, description: 'Cookie value. Required for set.' },
      domain:         { type: 'string', optional: true, description: 'Cookie domain. Optional for set and getAll filter.' },
      path:           { type: 'string', optional: true, description: 'Cookie path. Defaults to "/" for set.' },
      secure:         { type: 'boolean', optional: true, description: 'Whether the cookie requires HTTPS.' },
      httpOnly:       { type: 'boolean', optional: true, description: 'Whether the cookie is HTTP-only (not accessible via JS).' },
      expirationDate: { type: 'number', optional: true, description: 'Expiration as seconds since epoch. Omit for session cookie.' },
    },
    operationTypes: ['read', 'create', 'delete'],
    loader:         () => import('./manage_cookies'),
  },
  {
    name:        'background_browse',
    description: 'Browse the web in a hidden tab without disrupting the user\'s visible browser. Open pages, read content, navigate, and close — all in the background. Ideal for research, checking URLs, or scraping data while the user works.',
    category:    'browser',
    schemaDef:   {
      action: { type: 'enum', enum: ['open', 'read', 'navigate', 'close', 'list'], description: 'open: create hidden tab and read content. read: read from existing. navigate: load new URL. close: destroy. list: show all hidden tabs.' },
      url:    { type: 'string', optional: true, description: 'URL to open or navigate to.' },
      tabId:  { type: 'string', optional: true, description: 'ID of an existing hidden tab. Required for read, navigate, close.' },
      waitMs: { type: 'number', optional: true, description: 'Milliseconds to wait for page load before reading content. Default 3000.' },
      code:   { type: 'string', optional: true, description: 'Custom JavaScript to execute instead of default content extraction. For read action.' },
    },
    operationTypes: ['read', 'execute'],
    loader:         () => import('./background_browse'),
  },
  {
    name:        'notify_user',
    description: 'Send a desktop notification to alert the user. Use when an async task completes, an error needs attention, or you want to communicate while the user is in another app.',
    category:    'browser',
    schemaDef:   {
      title:   { type: 'string', description: 'Notification title (short, attention-grabbing).' },
      message: { type: 'string', description: 'Notification body text with details.' },
      id:      { type: 'string', optional: true, description: 'Optional notification ID. Auto-generated if omitted.' },
      silent:  { type: 'boolean', optional: true, description: 'If true, suppress the notification sound. Default false.' },
    },
    operationTypes: ['execute'],
    loader:         () => import('./notify_user'),
  },
  {
    name:        'search_history',
    description: 'Search the user\'s browsing history by text query and/or time range. Find pages visited previously, check when a site was last accessed, or recall URLs the user looked at earlier.',
    category:    'browser',
    schemaDef:   {
      query:      { type: 'string', optional: true, description: 'Text to search for in URLs and page titles. Leave empty to list recent history.' },
      maxResults: { type: 'number', optional: true, description: 'Maximum results to return. Default 20.' },
      startTime:  { type: 'number', optional: true, description: 'Only return entries after this time (ms since epoch).' },
      endTime:    { type: 'number', optional: true, description: 'Only return entries before this time (ms since epoch).' },
    },
    operationTypes: ['read'],
    loader:         () => import('./search_history'),
  },
  {
    name:        'modify_history',
    description: 'Add, delete, or clear browsing history entries. Use to record researched URLs, remove sensitive entries, or clear history for privacy.',
    category:    'browser',
    schemaDef:   {
      action: { type: 'enum', enum: ['add', 'delete', 'deleteAll'], description: 'add: record a URL visit. delete: remove all entries for a URL. deleteAll: clear entire browsing history.' },
      url:    { type: 'string', optional: true, description: 'URL to add or delete. Required for add and delete.' },
      title:  { type: 'string', optional: true, description: 'Page title for add action. Optional.' },
    },
    operationTypes: ['create', 'delete'],
    loader:         () => import('./modify_history'),
  },
  {
    name:        'search_conversations',
    description: 'Search past chat conversations, browser visits, and workflow executions. Find previous discussions by keyword, list recent activity, or retrieve details by ID or thread ID. Searches the conversation history database — use search_history for browsing URL history.',
    category:    'browser',
    schemaDef:   {
      action:   { type: 'enum', enum: ['search', 'recent', 'get'], description: 'search: full-text search by query. recent: list recent conversations. get: retrieve a specific conversation by id or threadId.' },
      query:    { type: 'string', optional: true, description: 'Search text to match against conversation titles and summaries. Required for search action.' },
      limit:    { type: 'number', optional: true, description: 'Max results for recent action. Default 20.' },
      type:     { type: 'enum', enum: ['chat', 'browser', 'workflow', 'graph'], optional: true, description: 'Filter by conversation type. For recent action.' },
      id:       { type: 'string', optional: true, description: 'Conversation ID. For get action.' },
      threadId: { type: 'string', optional: true, description: 'Thread ID. For get action (alternative to id).' },
    },
    operationTypes: ['read'],
    loader:         () => import('./search_conversations'),
  },
  {
    name:        'agent_storage',
    description: 'Persistent key-value store for agent state that survives across conversations. Store task progress, discovered user preferences, cached API responses, or any structured data. Backed by the database.',
    category:    'browser',
    schemaDef:   {
      action: { type: 'enum', enum: ['get', 'set', 'remove'], description: 'get: retrieve values by key(s). set: store key-value pairs. remove: delete key(s).' },
      keys:   { type: 'string', optional: true, description: 'Key or comma-separated keys to get or remove. Omit to get all stored values.' },
      data:   { type: 'object', optional: true, description: 'Object of key-value pairs to store. Required for set action.' },
    },
    operationTypes: ['read', 'create', 'delete'],
    loader:         () => import('./agent_storage'),
  },
  {
    name:        'monitor_network',
    description: 'Monitor network requests for a duration. Capture all requests (with status codes) or watch for errors/failures. Useful for debugging API calls, checking service health, or understanding what network traffic a page generates.',
    category:    'browser',
    schemaDef:   {
      action:          { type: 'enum', enum: ['capture', 'watch_errors'], description: 'capture: record all requests for the duration. watch_errors: only collect failed requests (network errors + HTTP 4xx/5xx).' },
      durationSeconds: { type: 'number', optional: true, description: 'How long to monitor in seconds. Default 5 for capture, 10 for watch_errors.' },
      urlFilter:       { type: 'string', optional: true, description: 'Only capture requests whose URL contains this string. For capture action.' },
    },
    operationTypes: ['read'],
    loader:         () => import('./monitor_network'),
  },
  {
    name:        'schedule_alarm',
    description: 'Set, list, or clear named timers. Use for deferred checks ("check the deploy in 5 minutes"), periodic polling, or simple reminders. Alarms fire in-process and do not survive app restarts.',
    category:    'browser',
    schemaDef:   {
      action:          { type: 'enum', enum: ['create', 'get', 'list', 'clear', 'clearAll'], description: 'create: set a new alarm. get: check a specific alarm. list: show all. clear: cancel one. clearAll: cancel all.' },
      name:            { type: 'string', optional: true, description: 'Alarm name. Required for create, get, clear.' },
      delayInMinutes:  { type: 'number', optional: true, description: 'Minutes before the alarm fires (one-shot). For create.' },
      periodInMinutes: { type: 'number', optional: true, description: 'Repeat interval in minutes. For create. Can combine with delayInMinutes.' },
      when:            { type: 'number', optional: true, description: 'Absolute fire time as ms since epoch. For create.' },
    },
    operationTypes: ['create', 'read', 'delete'],
    loader:         () => import('./schedule_alarm'),
  },
];

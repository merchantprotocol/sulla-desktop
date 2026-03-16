import type { ToolManifest } from '../registry';

export const playwrightToolManifests: ToolManifest[] = [
  {
    name:        'click_element',
    description: 'Click a button, link, or interactive element on a website asset. Use handles from get_page_snapshot (e.g. @btn-save, @link-home) or a CSS selector or data-test-id. Omit assetId to target the active asset.',
    category:    'playwright',
    schemaDef:   {
      handle:  { type: 'string', description: 'The element handle (@btn-<slug>, @link-<slug>, data-test-id, or CSS selector)' },
      assetId: { type: 'string', optional: true, description: 'Target asset ID (omit for the currently active website)' },
    },
    operationTypes: ['execute'],
    loader:         () => import('./click_element'),
  },
  {
    name:        'get_form_values',
    description: 'Get a map of all visible form field values (inputs, textareas, selects) from a website asset. Omit assetId to target the active asset.',
    category:    'playwright',
    schemaDef:   {
      assetId: { type: 'string', optional: true, description: 'Target asset ID (omit for the currently active website)' },
    },
    operationTypes: ['read'],
    loader:         () => import('./get_form_values'),
  },
  {
    name:        'get_page_snapshot',
    description: 'Get an actionable Markdown snapshot of a website asset showing all visible buttons, links, and form fields with their handles. Omit assetId to target the active asset, or specify one from list_active_pages.',
    category:    'playwright',
    schemaDef:   {
      assetId: { type: 'string', optional: true, description: 'Target asset ID (omit for the currently active website)' },
    },
    operationTypes: ['read'],
    loader:         () => import('./get_page_snapshot'),
  },
  {
    name:        'get_page_text',
    description: 'Get the visible text content (innerText) of a website asset, including the page title and URL. Omit assetId to target the active asset.',
    category:    'playwright',
    schemaDef:   {
      assetId: { type: 'string', optional: true, description: 'Target asset ID (omit for the currently active website)' },
    },
    operationTypes: ['read'],
    loader:         () => import('./get_page_text'),
  },
  {
    name:        'scroll_to_element',
    description: 'Scroll a matching element into view on a website asset using a CSS selector. Omit assetId to target the active asset.',
    category:    'playwright',
    schemaDef:   {
      selector: { type: 'string', description: 'CSS selector of the element to scroll into view' },
      assetId:  { type: 'string', optional: true, description: 'Target asset ID (omit for the currently active website)' },
    },
    operationTypes: ['execute'],
    loader:         () => import('./scroll_to_element'),
  },
  {
    name:        'set_field',
    description: 'Set the value of a form field (input, textarea, select) on a website asset. Use handles from get_page_snapshot (e.g. @field-email, @field-username). Omit assetId to target the active asset.',
    category:    'playwright',
    schemaDef:   {
      handle:  { type: 'string', description: 'The field handle (@field-<id|name>) or element id/name' },
      value:   { type: 'string', description: 'The value to set' },
      assetId: { type: 'string', optional: true, description: 'Target asset ID (omit for the currently active website)' },
    },
    operationTypes: ['update'],
    loader:         () => import('./set_field'),
  },
  {
    name:        'wait_for_element',
    description: 'Wait for a CSS selector to become visible on a website asset. Useful after clicking a button to wait for new content to appear. Omit assetId to target the active asset.',
    category:    'playwright',
    schemaDef:   {
      selector: { type: 'string', description: 'CSS selector to wait for' },
      timeout:  { type: 'number', optional: true, default: 5000, description: 'Maximum time to wait in milliseconds (default 5000)' },
      assetId:  { type: 'string', optional: true, description: 'Target asset ID (omit for the currently active website)' },
    },
    operationTypes: ['read'],
    loader:         () => import('./wait_for_element'),
  },
];

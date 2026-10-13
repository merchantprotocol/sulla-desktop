import type { ToolManifest } from '../registry';

const accountId = { type: 'string', optional: true, description: 'Google Drive vault account id. Omit to use the active account.' } as const;

export const gdriveToolManifests: ToolManifest[] = [
  {
    name:        'gdrive_list_folder',
    description: 'List what is inside a Google Drive folder (Docs, Sheets, Slides, PDFs, images, videos, subfolders). Accepts a folder id or any drive.google.com folder URL. Set recursive:true to walk the whole tree with each item\'s path.',
    category:    'gdrive',
    schemaDef:   {
      folder:    { type: 'string', optional: true, default: 'root', description: 'Folder id or Drive folder URL. Defaults to My Drive root.' },
      recursive: { type: 'boolean', optional: true, default: false, description: 'Walk subfolders too (capped at 2000 items).' },
      maxDepth:  { type: 'number', optional: true, description: 'Max folder depth when recursive (1-6, default 6).' },
      pageToken: { type: 'string', optional: true, description: 'nextPageToken from a previous non-recursive call.' },
      accountId,
    },
    operationTypes: ['read'],
    loader:         () => import('./list_folder'),
  },
  {
    name:        'gdrive_search',
    description: 'Search Google Drive by file name and full text. Optionally limit to one folder or MIME type, or pass raw Drive query syntax in q.',
    category:    'gdrive',
    schemaDef:   {
      query:     { type: 'string', optional: true, description: 'Plain text to match in names and file contents.' },
      q:         { type: 'string', optional: true, description: 'Raw Drive query, e.g. "modifiedTime > \'2026-01-01\'".' },
      folder:    { type: 'string', optional: true, description: 'Only direct children of this folder id/URL.' },
      mimeType:  { type: 'string', optional: true, description: 'Exact MIME type, e.g. application/vnd.google-apps.document.' },
      limit:     { type: 'number', optional: true, default: 50, description: 'Max results (1-200).' },
      pageToken: { type: 'string', optional: true, description: 'nextPageToken from a previous call.' },
      accountId,
    },
    operationTypes: ['read'],
    loader:         () => import('./search'),
  },
  {
    name:        'gdrive_read',
    description: 'Read a Drive file as text: Google Docs as Markdown, Sheets as CSV (first tab), Slides as plain text, and plain text/JSON/CSV files as-is. Accepts a file id or any Docs/Sheets/Slides/Drive URL. For PDFs, images and videos use gdrive_download.',
    category:    'gdrive',
    schemaDef:   {
      file:     { type: 'string', description: 'File id or Google Docs/Sheets/Slides/Drive URL.' },
      maxChars: { type: 'number', optional: true, default: 100000, description: 'Truncate content after this many characters.' },
      accountId,
    },
    operationTypes: ['read'],
    loader:         () => import('./read'),
  },
  {
    name:        'gdrive_download',
    description: 'Save a Drive file to local disk (default ~/sulla/cache/gdrive/) and return the path, so PDFs, images and videos can be read or viewed. Google Docs/Sheets/Slides are exported (default pdf/xlsx/pdf; override with format).',
    category:    'gdrive',
    schemaDef:   {
      file:           { type: 'string', description: 'File id or Google Docs/Sheets/Slides/Drive URL.' },
      format:         { type: 'enum', enum: ['pdf', 'docx', 'xlsx', 'pptx', 'md', 'txt', 'csv', 'png', 'svg'], optional: true, description: 'Export format for Google-native files.' },
      destinationDir: { type: 'string', optional: true, description: 'Directory to save into. Defaults to ~/sulla/cache/gdrive.' },
      accountId,
    },
    operationTypes: ['read'],
    loader:         () => import('./download'),
  },
];

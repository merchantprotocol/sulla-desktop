---
slug: sulla-tool-gdrive
label: Use the Sulla gdrive tools
trigger_when: When you need to find, inspect, read, or download a file from Google Drive.
trigger_actions: [gdrive, Sulla gdrive tool, tool call]
trigger_phrases: [Google Drive, Drive file, search Drive, read a document, download from Drive]
scope: [tool-gdrive]
---

**When:** Use `exec` to dispatch an exact `sulla gdrive/<tool>` command. Discover current tools with `sulla meta/browse_tools '{"category":"gdrive"}'` before an unfamiliar call.

**Tools:**

<!-- tools:generated:start -->
- `sulla gdrive/download '{"file":"<file>"}'`: Save a Drive file to local disk (default ~/sulla/cache/gdrive/) and return the path, so PDFs, images and videos can be read or viewed. Google Docs/Sheets/Slides are exported (default pdf/xlsx/pdf; override with format). Required: file. Optional: format, destinationDir.
- `sulla gdrive/list_folder '{}'`: List what is inside a Google Drive folder (Docs, Sheets, Slides, PDFs, images, videos, subfolders). Accepts a folder id or any drive.google.com folder URL. Set recursive:true to walk the whole tree with each item's path. Required: none. Optional: folder, recursive, maxDepth, pageToken.
- `sulla gdrive/read '{"file":"<file>"}'`: Read a Drive file as text: Google Docs as Markdown, Sheets as CSV (first tab), Slides as plain text, and plain text/JSON/CSV files as-is. Accepts a file id or any Docs/Sheets/Slides/Drive URL. For PDFs, images and videos use gdrive_download. Required: file. Optional: maxChars.
- `sulla gdrive/search '{}'`: Search Google Drive by file name and full text. Optionally limit to one folder or MIME type, or pass raw Drive query syntax in q. Required: none. Optional: query, q, folder, mimeType, limit, pageToken.
<!-- tools:generated:end -->
**Do:**
1. `sulla gdrive/search {"query":"<keywords>"}` to find matching files.
2. `sulla gdrive/read {"file":"<file id or URL>"}` to read a document, sheet, or slide as text.
3. `sulla gdrive/download {"file":"<file id or URL>","format":"pdf"}` when a local copy is needed.
4. `sulla gdrive/list_folder {"folder":"<folder id or URL>","recursive":true}` to inventory a folder.

**Don't:**
- Don't assume a Drive URL is public; the configured vault account supplies access.
- Don't download sensitive files to a shared or unsafe location.

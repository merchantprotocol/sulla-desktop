---
slug: sulla-tool-gdrive
label: Use the Sulla gdrive tools
trigger_when: When you need to search, read, list, or download Google Drive files.
trigger_actions: [gdrive, Sulla gdrive tool, tool call]
trigger_phrases: [gdrive]
scope: [tool-gdrive]
---

**When:** Use `exec` to dispatch an exact `sulla gdrive/<tool>` command. Discover current tools with `sulla meta/browse_tools '{"category":"gdrive"}'` before an unfamiliar call.

**Tools:**
- `sulla gdrive/list_folder '{}'`: List what is inside a Google Drive folder (Docs, Sheets, Slides, PDFs, images, videos, subfolders). Accepts a folder id or any drive.google.com folder URL. Set recursive:true to walk the whole tree with each item\'s path. Required: none.
- `sulla gdrive/search '{}'`: Search Google Drive by file name and full text. Optionally limit to one folder or MIME type, or pass raw Drive query syntax in q. Required: none.
- `sulla gdrive/read '{"file":"<file>"}'`: Read a Drive file as text: Google Docs as Markdown, Sheets as CSV (first tab), Slides as plain text, and plain text/JSON/CSV files as-is. Accepts a file id or any Docs/Sheets/Slides/Drive URL. For PDFs, images and videos use gdrive_download. Required: file.
- `sulla gdrive/download '{"file":"<file>"}'`: Save a Drive file to local disk (default ~/sulla/cache/gdrive/) and return the path, so PDFs, images and videos can be read or viewed. Google Docs/Sheets/Slides are exported (default pdf/xlsx/pdf; override with format). Required: file.

**Do:**
1. Discover the category when names or parameters may have changed.
2. Run the command through `exec`, passing one JSON object with required parameters.
3. Treat returned IDs, cursors, and SHAs as inputs to the next call; verify destructive or outward-facing results.

**Don't:**
- Don't assume a Drive URL is public; vault authentication is used.
- Don't download sensitive files to an unsafe destination or expose their contents.

# gdrive — Google Drive (read-only)

Native tools for reading the human's Google Drive: folders, Docs, Sheets, Slides, PDFs, images and videos. Read-only — nothing is created, edited, shared or deleted.

## Setup (one time, done by the human)

1. In Google Cloud Console, enable the **Google Drive API** and create an **OAuth client ID** of type **Desktop app**.
2. Integrations → **Google Drive** → paste the Client ID + Client Secret → **Connect with Google**.
3. The consent screen asks for read-only Drive access (`drive.readonly`).

Tokens live in the vault under integration id `google_drive` and refresh automatically. Check status with `sulla vault/list_accounts '{"account_type":"google_drive"}'`.

## Tools

Every `folder` / `file` argument takes either a bare Drive id or a full URL (`drive.google.com/drive/folders/…`, `docs.google.com/document/d/…/edit`, `…/spreadsheets/d/…`, `…/presentation/d/…`, `open?id=…`). Shortcuts are followed. Shared drives are included.

| Command | What it does |
|---|---|
| `sulla gdrive/list_folder '{"folder":"<url>"}'` | Direct children of a folder. Add `"recursive":true` to walk the tree (each item gets a `path`; capped at 2000 items). |
| `sulla gdrive/search '{"query":"brand voice"}'` | Name + full-text search. Optional `folder`, `mimeType`, `limit`, or raw Drive syntax in `q`. |
| `sulla gdrive/read '{"file":"<url>"}'` | Text content: Docs → Markdown, Sheets → CSV (first tab only), Slides → plain text, text/JSON/CSV files as-is. `maxChars` defaults to 100000. |
| `sulla gdrive/download '{"file":"<url>"}'` | Saves to `~/sulla/cache/gdrive/` and returns `savedTo`. Use for PDFs, images, videos, or to get a Sheet as xlsx (`"format":"xlsx"`). |

## Typical flow: learn a strategy folder

1. `gdrive/list_folder` with `recursive:true` on the folder URL.
2. `gdrive/read` each Doc / Slides / Sheet.
3. `gdrive/download` PDFs and images, then read/view the saved files.
4. Save durable takeaways to memory/observations — not raw document text.

## Errors

- *Google Drive is not connected* → the human needs to do Setup above.
- *403 … Drive API is not enabled* → enable the Drive API in the same Google Cloud project as the OAuth client.
- *404* → wrong id, or the connected Google account can't open that item.

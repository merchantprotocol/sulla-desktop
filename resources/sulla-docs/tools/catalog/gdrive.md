# gdrive tools

Google Drive (read-only) — list folders, search, read Docs/Sheets/Slides as text, and download PDFs/images/videos to disk. Needs the Google Drive integration connected.

## download

Save a Drive file to local disk (default ~/sulla/cache/gdrive/) and return the path, so PDFs, images and videos can be read or viewed. Google Docs/Sheets/Slides are exported (default pdf/xlsx/pdf; override with format).

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `file` | string | Required |
| `format` | enum: pdf\|docx\|xlsx\|pptx\|md\|txt\|csv\|png\|svg | Optional |
| `destinationDir` | string | Optional |
| `accountId` | string | Optional |

**Example**

```bash
sulla gdrive/download '{"file":"<file>"}'
```

## list_folder

List what is inside a Google Drive folder (Docs, Sheets, Slides, PDFs, images, videos, subfolders). Accepts a folder id or any drive.google.com folder URL.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `folder` | string | Optional |
| `recursive` | boolean | Optional |
| `maxDepth` | number | Optional |
| `pageToken` | string | Optional |
| `accountId` | string | Optional |

**Example**

```bash
sulla gdrive/list_folder '{}'
```

## read

Read a Drive file as text: Google Docs as Markdown, Sheets as CSV (first tab), Slides as plain text, and plain text/JSON/CSV files as-is. Accepts a file id or any Docs/Sheets/Slides/Drive URL.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `file` | string | Required |
| `maxChars` | number | Optional |
| `accountId` | string | Optional |

**Example**

```bash
sulla gdrive/read '{"file":"<file>"}'
```

## search

Search Google Drive by file name and full text. Optionally limit to one folder or MIME type, or pass raw Drive query syntax in q.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `query` | string | Optional |
| `q` | string | Optional |
| `folder` | string | Optional |
| `mimeType` | string | Optional |
| `limit` | number | Optional |
| `pageToken` | string | Optional |
| `accountId` | string | Optional |

**Example**

```bash
sulla gdrive/search '{}'
```

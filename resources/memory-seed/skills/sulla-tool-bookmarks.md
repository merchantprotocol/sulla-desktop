---
slug: sulla-tool-bookmarks
label: Use the Sulla Bookmarks tools
trigger_when: When you need to use Sulla Bookmarks operations.
trigger_actions: [bookmarks, bookmarks tools]
trigger_phrases: [bookmarks, bookmarks]
scope: [tool-bookmarks]
---

**When:** When you need to use Sulla Bookmarks operations.

**Do:**
1. Use the exact command and parameters listed below.
2. Read returned state before making a follow-up change.
3. Keep destructive actions behind their required confirmation fields.

**Tools:**

# bookmarks tools

Manage the app Bookmarks pane — save useful links and agent-owned items, search and list bookmarks, organize folders, move items, and remove them.

## add

Save a useful link, research source, dashboard, deploy URL, artifact, or other agent-owned item in the app Bookmarks pane. Defaults to a root Sulla folder and avoids duplicate URLs within the destination folder.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `url` | string | Required |
| `title` | string | Optional |
| `folderId` | string | Optional |
| `folderPath` | string | Optional |

**Example**

```bash
sulla bookmarks/add '{"url":"<url>"}'
```

## create_folder

Create a folder in the app Bookmarks pane to organize links and agent-owned items.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `title` | string | Required |
| `parentId` | string | Optional |

**Example**

```bash
sulla bookmarks/create_folder '{"title":"<title>"}'
```

## list

List bookmarks from the app Bookmarks pane as a nested tree or as the direct children of one folder. Returns bookmark metadata without favicon blobs.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `format` | enum: tree\|flat | Optional |
| `folderId` | string | Optional |

**Example**

```bash
sulla bookmarks/list '{}'
```

## move

Move or reorder a bookmark or folder in the app Bookmarks pane.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `id` | string | Required |
| `parentId` | string | Optional |
| `index` | number | Optional |

**Example**

```bash
sulla bookmarks/move '{"id":"<id>"}'
```

## remove

Remove a bookmark or folder from the app Bookmarks pane. Non-empty folders require recursive: true and are removed with all descendants.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `id` | string | Required |
| `recursive` | boolean | Optional |

**Example**

```bash
sulla bookmarks/remove '{"id":"<id>"}'
```

## search

Search bookmark and folder titles and bookmark URLs. Use this to find saved research sources, dashboards, deploy URLs, and agent-owned items.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `query` | string | Required |

**Example**

```bash
sulla bookmarks/search '{"query":"<query>"}'
```

## update

Rename a bookmark or folder, or change a bookmark URL in the app Bookmarks pane.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `id` | string | Required |
| `title` | string | Optional |
| `url` | string | Optional |

**Example**

```bash
sulla bookmarks/update '{"id":"<id>"}'
```


**Don't:**
- Don't invent tool names or parameters; check `sulla meta/browse_tools` when the catalog and source differ.
- Don't expose secrets, tokens, or private data in output.

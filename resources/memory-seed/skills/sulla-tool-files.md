---
slug: sulla-tool-files
label: Use the Sulla Files tools
trigger_when: When you need to use Sulla Files operations.
trigger_actions: [files, files tools]
trigger_phrases: [files, files]
scope: [tool-files]
---

**When:** When you need to use Sulla Files operations.

**Do:**
1. Use the exact command and parameters listed below.
2. Read returned state before making a follow-up change.
3. Keep destructive actions behind their required confirmation fields.

**Tools:**

# files tools

Versioned shared files, history, restore, links, search, and sharing.

## collections

List the Files collections the launching person can see in the File Manager, with ids and roles.

**Parameters**

None.

**Example**

```bash
sulla files/collections '{}'
```

## create_folder

Create a Files folder when no described folder fits. Agents must explain the folder purpose.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `collection_id` | string | Required |
| `path` | string | Required |
| `description` | string | Required |
| `naming_hint` | string | Optional |

**Example**

```bash
sulla files/create_folder '{"collection_id":"<collection_id>","path":"<path>","description":"<description>"}'
```

## history

List every version of a Sulla file.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `path` | string | Optional |
| `file_id` | string | Optional |

**Example**

```bash
sulla files/history '{}'
```

## link

Create a public Sulla Cloud share link for a file or folder. Captures default to a temporary Cloud copy; ordinary files default to Desktop pass-through.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `path` | string | Optional |
| `file_id` | string | Optional |
| `collection_id` | string | Optional |
| `folder_path` | string | Optional |
| `target_file_id` | string | Optional |
| `kind` | enum: links_to\|derived_from | Optional |
| `access_mode` | enum: view\|download | Optional |
| `password` | string | Optional |
| `expires_at` | string | Optional |
| `keep_available` | boolean | Optional |
| `asset_kind` | enum: file\|capture\|artifact | Optional |
| `capture_metadata` | object | Optional |

**Example**

```bash
sulla files/link '{}'
```

## list

List files in a collection exactly as the File Manager loads them. Optional path prefix, trash, and limit (default 200).

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `collection_id` | string | Required |
| `path` | string | Optional |
| `trash` | boolean | Optional |
| `limit` | number | Optional |

**Example**

```bash
sulla files/list '{"collection_id":"<collection_id>"}'
```

## request_publish

Request human approval to publish a draft file version. Returns immediately.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `file_id` | string | Required |
| `version_id` | string | Required |
| `reason` | string | Optional |

**Example**

```bash
sulla files/request_publish '{"file_id":"<file_id>","version_id":"<version_id>"}'
```

## restore

Restore an older file version as a new current version.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `path` | string | Optional |
| `file_id` | string | Optional |
| `version_id` | string | Required |

**Example**

```bash
sulla files/restore '{"version_id":"<version_id>"}'
```

## revoke_link

Revoke a public share link and remove any temporary Cloud copy.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `id` | string | Required |

**Example**

```bash
sulla files/revoke_link '{"id":"<id>"}'
```

## search

Hybrid search over files the launching person can access. Supports folder, type, person, and date filters; accepts an optional absolute path prefix; omit it to search all accessible files.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `path` | string | Optional |
| `collection_id` | string | Optional |
| `query` | string | Required |
| `folder` | string | Optional |
| `type` | string | Optional |
| `person` | string | Optional |
| `from` | string | Optional |
| `to` | string | Optional |

**Example**

```bash
sulla files/search '{"query":"<query>"}'
```

## shared

List public links shared by the signed-in user, including views, expiry, keep-available state, source and revocation.

**Parameters**

None.

**Example**

```bash
sulla files/shared '{}'
```

## versions

List versions with publication, lock, and retention state.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `file_id` | string | Required |

**Example**

```bash
sulla files/versions '{"file_id":"<file_id>"}'
```

## where

Find the best described Files folder before saving. Returns ranked folders plus a suggested folder and filename.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `what` | string | Required |
| `kind` | string | Optional |
| `project` | string | Optional |

**Example**

```bash
sulla files/where '{"what":"<what>"}'
```


**Don't:**
- Don't invent tool names or parameters; check `sulla meta/browse_tools` when the catalog and source differ.
- Don't expose secrets, tokens, or private data in output.

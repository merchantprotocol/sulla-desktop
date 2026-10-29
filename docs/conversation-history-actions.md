# Conversation history actions and resume contract

## Audit (2026-10-29)

| Capability | Before this change |
| --- | --- |
| Rename | The database model had `updateTitle`, but no renderer IPC or History UI action. |
| Pin/unpin | The model had `pin`; History only toggled an in-memory field, so it disappeared on reload. Pinned ordering was renderer-only. |
| Archive/unarchive | The model could archive by overloading `status`, but no unarchive, Archived view, IPC, or UI action existed. Archived rows incorrectly remained in the main recent/search results. |
| Delete/recover | History hard-deleted the header and cascaded its transcript, then removed the log file. It was not recoverable. |
| Search | Title/summary search worked, but included archived rows in the main view and could not search the Archived view. |
| Click to resume | The main History page and in-chat rail restored the original tab/thread and had a PostgreSQL transcript fallback. The durable `conversation_messages` store preserves message order and thread state. Actions above could still destroy or hide the only durable header, and archived filtering was absent. |
| Menus | History had inline pin/delete buttons only. There was no row context menu or ellipsis menu. |

The implementation keeps the approved History layout and fills these behavior gaps.

## Desktop / mobile / Cloud operation contract

Conversation projections expose these stable fields:

```ts
{ id: string, title: string | null, pinned: boolean, archived: boolean }
```

Desktop IPC uses `conversation-history:list`, `conversation-history:search`, and `conversation-history:update`. The update payload is a partial patch:

```ts
{ title?: string, pinned?: boolean, archived?: boolean, deleted?: boolean }
```

Omitted fields are unchanged. `deleted: true` is a recoverable soft delete; `deleted: false` restores it. Lists default to active conversations and accept `view: 'active' | 'archived' | 'deleted'`. Mobile and Cloud sync should send the same field names and partial-patch semantics. A conversation keeps the same `id` and `thread_id`; resume and subsequent appends therefore target the same durable thread.

# The `.sulla` file format

`.sulla` is the native document type of the Sulla document editor, the
Obsidian-like editor inside the File Manager. A `.sulla` file is a plain
UTF-8 Markdown file with optional YAML-style front matter. There is no binary
container, no JSON wrapper, and no hidden sidecar. Any Markdown tool can read it,
and agents can write it with normal file tools on `/mnt/sulla-files`.

The native extension is bare `.sulla` (`Project Priorities.sulla`). Older
`.sulla.md` files are still accepted and behave the same.

## Which files open in the editor

The editor picks a type from the end of the file name (case-insensitive):

| Ends with | Editor type | Behaviour |
| --- | --- | --- |
| `.sulla` | Markdown | Live preview, property pills, slash menu |
| `.sulla.md` | Markdown | Same as `.sulla` (older name) |
| `.md` | Markdown | Same as `.sulla` |
| `.txt` | Text | Plain monospace editor, no front matter, no preview |

Everything else opens in the normal file preview. Today `.sulla` and `.md`
behave the same. Use `.sulla` for documents meant to be worked on in Sulla.
File Manager's **New → Sulla Document** creates `Untitled.sulla`.

The Files service stores `.sulla` files with mime `text/markdown`, so search
indexing and previews treat them as Markdown.

## File layout

```markdown
---
status: active
owner: Jonathon
priority: high
---

# Optional heading

Body in ordinary Markdown.

- [ ] An open task
- [x] A finished task
```

### Front matter (properties)

- Optional. If it is present, it must start on the **very first line** with `---`
  and close with a line that is exactly `---`. Both LF and CRLF line endings work.
- The editor reads it as flat `key: value` lines. It splits each line at the
  first `:`, trims both sides, and strips one pair of surrounding quotes from the
  value. Lines without a `:` are ignored.
- Nested YAML, lists and multi-line values are **not** understood as properties.
  They survive untouched in the file, but they don't render as pills.
- Every property shows as a pill under the title (`key value`). Clicking a pill
  puts the cursor in the raw front matter so you can edit it. The raw YAML is
  hidden while the cursor is outside it.
- Properties are display-only for now. Nothing in Sulla reads or enforces
  specific keys yet. Pick keys freely.

### Title

The editor does not show a title from the front matter or the first `#`
heading. It builds the title from the **file name**: it removes `.sulla`,
`.sulla.md`, `.md` or `.txt` and turns `-` and `_` into spaces. So
`project-priorities.sulla` shows as "project priorities". Name files the way
you want the title to read.

### Body

The body is standard Markdown (the CodeMirror `lang-markdown` parser). The live
preview styles:

- ATX headings `#`, `##` and `###` (display font, sized)
- `**bold**` and `*italic*`
- `[links](https://…)` (underlined, accent colour)
- Task markers `- [ ]` and `- [x]`
- Images `![alt](https://…)` only when the URL is `http`/`https`, and only while
  the cursor is off that line. Relative and Files-path images stay as raw text.

Tables, `<details>` toggles, code and anything else Markdown supports are kept
and saved exactly as written, but they show as source rather than rendered
widgets.

The editor **never normalizes content**. The exact bytes are preserved: no
reformatting, no front-matter rewriting, no line-ending changes. Agents can
safely write a file and expect it back byte-for-byte.

### Slash menu ("Insert block")

The menu adds these snippets at the **end** of the document:

| Item | Inserts |
| --- | --- |
| Heading | `## Heading` |
| List | `- List item` |
| Checklist | `- [ ] Task` |
| Table | a 2-column Markdown table |
| Toggle | `<details><summary>Toggle</summary></details>` |
| Link | `[link](https://)` |

"Chart" and "Sulla component" appear in the menu but are disabled. There is no
chart or component block syntax yet. Do not invent one.

## Links

Obsidian-style `[[wikilinks]]` are **not** parsed. They are saved as plain text
and create no link.

The Links drawer shows **file edges** stored by the Files service, not links
found in the text. Edges have kind `links_to` or `derived_from` and are created
through `POST /v1/file-edges` (`fileId`, `targetFileId`, `kind`). The drawer lists
each linked file with its direction (`outgoing` or `incoming`).

## Saving, versions and live editing

- **Live mode** (normal case): opening a document joins a live session
  (`POST /v1/files/:id/live`) that syncs over Automerge. Several people and agents
  can edit at once, and the presence avatars show who is in the document. Edits
  are flushed into a new Files version about 2 seconds after the last change.
  Those versions carry the message "Live document edit". The status chip reads
  Live, Syncing… or Offline. Offline edits are kept and replayed on reconnect.
- **Fallback save** (live unavailable): edits are saved about 850 ms after
  typing stops, or right away with Cmd/Ctrl+S, through
  `PUT /v1/files/:id/content` with a `baseVersionId`. If the file changed
  elsewhere, the server merges with Automerge. If both edits touched the same
  span, a conflict banner offers "Reload latest" or "Keep mine".
- **Agent writes on the FUSE mount** are merged into any open live session.
  Writing a `.sulla` file while Jonathon has it open is safe: his edits
  aren't lost, and the agent appears briefly in presence.
- Live editing is limited to UTF-8 text up to 8 MiB. While a live session is
  open, binary or larger content can't replace the file (HTTP 415).
- Every save is a normal Files version. The History drawer lists them.
- If the caller lacks edit rights, the document opens read-only and shows a
  "Read only" pill.

## Rules for agents writing `.sulla`

1. Use the `.sulla` extension. Name the file for the title you want.
2. Keep front matter flat `key: value` if you want it shown as properties.
3. Write normal Markdown. Use `- [ ]` and `- [x]` for checklists.
4. Don't add `[[wikilinks]]` or invented block syntax and expect them to do anything.
5. Put image URLs as `http(s)` if they should render inline.
6. Write with normal tools on `/mnt/sulla-files`. Versioning, merge and audit
   happen automatically ([files.md](files.md)).

## Implementation references

- `pkg/sulla-desktop/pages/files/editor/editorTypes.ts`: extension → editor type
- `pkg/sulla-desktop/pages/files/editor/registry.ts`: front-matter parser, serialize
- `pkg/sulla-desktop/pages/files/editor/MarkdownEditingArea.vue`: live preview
- `pkg/sulla-desktop/pages/files/editor/DocumentEditorShell.vue`: title, properties, slash menu, save
- `pkg/sulla-desktop/pages/files/editor/liveDocument.ts` and `automergeYjsBridge.ts`: live sync
- `services/sulla-files/src/liveText.ts`, `automergeText.ts`, `app.ts` (`/live`, `/content`, `/file-edges`)
- `services/sulla-files/src/mimeTypes.ts`: `.sulla` and `.md` → `text/markdown`

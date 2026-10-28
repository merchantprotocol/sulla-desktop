---
slug: sulla-file-format
kind: system
name: Sulla Document Format
parent: sulla-files
aliases: [.sulla, Sulla Document, front matter, Markdown editor]
---

## Overview
A `.sulla` document is plain UTF-8 Markdown with optional YAML-style front matter. `.sulla.md` and `.md` open in the same Markdown editor; `.txt` opens as plain text. The file name supplies the displayed title. The editor supports live preview and task markers while Automerge remains the canonical document history.

## Facts
- Front matter must start on line one and end with a line containing only `---`.
- The editor understands flat `key: value` properties, not nested YAML, lists, or multiline property values.
- Files stores `.sulla` with MIME type `text/markdown`.

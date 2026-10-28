// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { Component } from 'vue';

import { documentEditorExtensions, documentEditorTypeIdForPath, type DocumentEditorTypeId } from './editorTypes';
import MarkdownEditingArea from './MarkdownEditingArea.vue';
import TextEditingArea from './TextEditingArea.vue';
import HtmlEditingArea from './HtmlEditingArea.vue';

export interface DocumentProperties { [key:string]: string }
export interface ParsedDocument { content:string; properties:DocumentProperties }
export interface DocumentEditorType {
  id:DocumentEditorTypeId;
  label:string;
  extensions:string[];
  component:Component;
  parse(content:string):ParsedDocument;
  serialize(document:ParsedDocument):string;
}

function identity(content:string):ParsedDocument { return { content, properties: {} } }
function parseMarkdown(content:string):ParsedDocument {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) return identity(content);
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return identity(content);
  const properties:DocumentProperties = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator > 0) properties[line.slice(0, separator).trim()] = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  // Content is deliberately never normalized. The editor owns the original bytes.
  return { content, properties };
}

const types:DocumentEditorType[] = [
  { id: 'markdown', label: 'Markdown', extensions: [...documentEditorExtensions.markdown], component: MarkdownEditingArea, parse: parseMarkdown, serialize: document => document.content },
  { id: 'text', label: 'Text', extensions: [...documentEditorExtensions.text], component: TextEditingArea, parse: identity, serialize: document => document.content },
  { id: 'html', label: 'HTML', extensions: [...documentEditorExtensions.html], component: HtmlEditingArea, parse: identity, serialize: document => document.content },
];

export function editorTypeForPath(path:string):DocumentEditorType | undefined {
  const id = documentEditorTypeIdForPath(path);
  return types.find(type => type.id === id);
}
export { supportsDocumentEditor } from './editorTypes';
export const documentEditorTypes = types;

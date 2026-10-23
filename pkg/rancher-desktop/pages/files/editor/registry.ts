import type { Component } from 'vue';

import MarkdownEditingArea from './MarkdownEditingArea.vue';
import TextEditingArea from './TextEditingArea.vue';

export interface DocumentProperties { [key:string]: string }
export interface ParsedDocument { content:string; properties:DocumentProperties }
export interface DocumentEditorType {
  id:'text' | 'markdown';
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
  { id: 'markdown', label: 'Markdown', extensions: ['.sulla.md', '.md'], component: MarkdownEditingArea, parse: parseMarkdown, serialize: document => document.content },
  { id: 'text', label: 'Text', extensions: ['.txt'], component: TextEditingArea, parse: identity, serialize: document => document.content },
];

export function editorTypeForPath(path:string):DocumentEditorType | undefined {
  const normalized = path.toLowerCase();
  return types.find(type => type.extensions.some(extension => normalized.endsWith(extension)));
}
export function supportsDocumentEditor(path:string):boolean { return Boolean(editorTypeForPath(path)) }
export const documentEditorTypes = types;

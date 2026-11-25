// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

const memoryTools = new Set([
  'episodic_resolve', 'episodic_search', 'episodic_recall', 'dream_recent_memories',
  'recall_conversations', 'recall_index_lookup', 'recall_index_store',
  'upsert_conversation_keywords', 'search_conversation_keywords', 'search_conversation_logs',
  'pack_list', 'pack_install', 'pack_sync', 'pack_uninstall', 'pack_validate',
]);
const browserOperations = ['open', 'navigate', 'read', 'screenshot', 'list', 'close'] as const;
const browserStatuses: readonly string[] = ['Running', 'Completed', 'Failed'];
export type HiddenBrowserOperation = typeof browserOperations[number];
export type ChatToolActivity = string;

export class ChatToolReporting {
  static hiddenOperation(value: unknown): HiddenBrowserOperation | undefined {
    return browserOperations.find(operation => operation === value);
  }

  static isBackgroundBrowse(name: unknown): boolean {
    return name === 'background_browse' || name === 'browser/background_browse' || name === 'browser_background_browse';
  }

  static isMemoryTool(value: string | undefined): boolean {
    return !!value && memoryTools.has(value.replace(/^(?:memory|observation)[_/]/, ''));
  }

  static describe(value: unknown): { label: string; text: string } | undefined {
    if (value === 'artifact-opened') return { label: 'Artifact', text: 'Artifact opened' };
    if (typeof value !== 'string' || !value) return undefined;
    // Known hidden-browser lifecycle strings keep their friendly wording; any
    // other activity is shown exactly as recorded, never dropped or masked.
    const [kind, action, status, extra] = value.split(':');
    const known = kind === 'browser' && extra === undefined && this.hiddenOperation(action) && browserStatuses.includes(status);
    return { label: 'Tool', text: known ? `Hidden browser · ${ action } · ${ status }` : value };
  }
}

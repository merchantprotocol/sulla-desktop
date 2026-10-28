// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { EditorState, type Extension } from '@codemirror/state';
import { drawSelection, EditorView, highlightActiveLine, keymap } from '@codemirror/view';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import type * as Y from 'yjs';

/** Live editing binds CodeMirror to the Automerge-backed Y.Text; undo then covers only this user's edits. */
export interface EditorCollaboration { ytext:Y.Text; undoManager:Y.UndoManager }

export function createEditor(parent:HTMLElement, content:string, readOnly:boolean, markdownMode:boolean, onChange:(content:string) => void, extra:Extension[] = [], collab?:EditorCollaboration|null):EditorView {
  return new EditorView({
    parent,
    state: EditorState.create({
      doc: collab ? collab.ytext.toString() : content,
      extensions: [
        collab ? yCollab(collab.ytext, null, { undoManager: collab.undoManager }) : history(), drawSelection(), highlightActiveLine(),
        keymap.of([...(collab ? yUndoManagerKeymap : []), ...defaultKeymap, ...(collab ? [] : historyKeymap), indentWithTab]),
        EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly),
        markdownMode ? markdown() : [], ...extra,
        EditorView.updateListener.of(update => { if (update.docChanged) onChange(update.state.doc.toString()) }),
        EditorView.theme({
          '&': { color: '#1a2332', backgroundColor: 'transparent', height: '100%' },
          '.cm-content': { caretColor: '#3a7fa0', padding: '4px 0 80px', fontFamily: markdownMode ? '-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif' : '"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace', fontSize: markdownMode ? '16px' : '14.5px', lineHeight: markdownMode ? '1.75' : '1.8' },
          '.cm-gutters': { backgroundColor: 'transparent', color: '#8a96a6', border: '0', paddingRight: '12px' },
          '.cm-activeLine,.cm-activeLineGutter': { backgroundColor: 'rgba(58,127,160,.06)' },
          '.cm-scroller': { overflow: 'visible' },
          '&.cm-focused': { outline: 'none' },
        }),
      ],
    }),
  });
}

/** Minimal source patch lets CodeMirror map cursors through remote changes. */
export function textPatch(before:string,after:string){let from=0;while(from<before.length&&from<after.length&&before[from]===after[from])from++;let end=0;while(end<before.length-from&&end<after.length-from&&before[before.length-end-1]===after[after.length-end-1])end++;return{from,to:before.length-end,insert:after.slice(from,after.length-end)};}

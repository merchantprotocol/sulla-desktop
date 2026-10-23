import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { EditorState, type Extension } from '@codemirror/state';
import { drawSelection, EditorView, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view';

export function createEditor(parent:HTMLElement, content:string, readOnly:boolean, markdownMode:boolean, onChange:(content:string) => void, extra:Extension[] = []):EditorView {
  return new EditorView({
    parent,
    state: EditorState.create({
      doc: content,
      extensions: [
        lineNumbers(), history(), drawSelection(), highlightActiveLine(),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly),
        markdownMode ? markdown() : [], ...extra,
        EditorView.updateListener.of(update => { if (update.docChanged) onChange(update.state.doc.toString()) }),
        EditorView.theme({
          '&': { color: 'var(--nx-text-primary, var(--text, #1a2332))', backgroundColor: 'transparent', height: '100%' },
          '.cm-content': { caretColor: 'var(--nx-accent, var(--accent, #3a7fa0))', padding: '4px 0 80px', fontFamily: markdownMode ? 'var(--font-body, ui-sans-serif)' : 'var(--font-mono, ui-monospace)', fontSize: markdownMode ? '16px' : '14.5px', lineHeight: markdownMode ? '1.75' : '1.8' },
          '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--nx-text-tertiary, #8a96a6)', border: '0', paddingRight: '12px' },
          '.cm-activeLine,.cm-activeLineGutter': { backgroundColor: 'color-mix(in srgb, var(--nx-accent, #3a7fa0) 6%, transparent)' },
          '.cm-scroller': { overflow: 'visible' },
          '&.cm-focused': { outline: 'none' },
        }),
      ],
    }),
  });
}

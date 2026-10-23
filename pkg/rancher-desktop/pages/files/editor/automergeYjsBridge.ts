import * as A from '@automerge/automerge';
import * as Y from 'yjs';

export type TextDoc = { text:string };

/** Transactions applied from Automerge; never mirrored back into Automerge and never undoable. */
export const AUTOMERGE_ORIGIN = Symbol('automerge');
/** Programmatic local edits (slash menu, property edits) that should be undoable like typing. */
export const LOCAL_ORIGIN = Symbol('local-edit');

/**
 * Yjs is only the editor's view of the Automerge text: it is built from Automerge, local
 * Y.Text edits are replayed into Automerge as splices, and Automerge patches are replayed into
 * Y.Text. Nothing Yjs-specific is ever synced or persisted, so Automerge is the only history.
 */
export class AutomergeYjsBridge {
  readonly ydoc = new Y.Doc();
  readonly ytext = this.ydoc.getText('text');
  readonly undoManager:Y.UndoManager;
  private current:A.Doc<TextDoc>;

  constructor(doc:A.Doc<TextDoc>, private readonly onLocalChange:() => void = () => {}) {
    this.current = doc;
    this.ydoc.transact(() => this.ytext.insert(0, doc.text ?? ''), AUTOMERGE_ORIGIN);
    this.undoManager = new Y.UndoManager(this.ytext, { trackedOrigins: new Set([LOCAL_ORIGIN]) });
    this.ytext.observe((event, transaction) => {
      if (transaction.origin === AUTOMERGE_ORIGIN) return;
      let index = 0;
      const next = A.change(this.current, draft => {
        if (typeof draft.text !== 'string') draft.text = '';
        for (const op of event.delta) {
          if (op.retain) index += op.retain;
          else if (typeof op.insert === 'string') { A.splice(draft, ['text'], index, 0, op.insert); index += op.insert.length }
          else if (op.delete) A.splice(draft, ['text'], index, op.delete);
        }
      });
      if (next === this.current) return;
      this.current = next;
      this.reconcile();
      this.onLocalChange();
    });
  }

  get doc():A.Doc<TextDoc> { return this.current }
  get text():string { return this.ytext.toString() }

  /** Applies a remote Automerge update (for example receiveSyncMessage) and replays its patches into Y.Text. */
  receive(apply:(doc:A.Doc<TextDoc>) => A.Doc<TextDoc>):boolean {
    const before = A.getHeads(this.current);
    const next = apply(this.current);
    const after = A.getHeads(next);
    this.current = next;
    if (before.join(',') === after.join(',')) return false;
    const patches = A.diff(next, before, after);
    this.ydoc.transact(() => {
      for (const patch of patches) {
        if (patch.path[0] !== 'text') continue;
        if (patch.path.length === 1) { this.replace(typeof next.text === 'string' ? next.text : ''); return }
        const at = Number(patch.path[1]);
        if (patch.action === 'splice') this.ytext.insert(at, patch.value);
        else if (patch.action === 'del') this.ytext.delete(at, patch.length ?? 1);
      }
    }, AUTOMERGE_ORIGIN);
    this.reconcile();
    return true;
  }

  /** Replaces the text through Yjs with a minimal edit, so it is undoable and synced like typing. */
  setText(value:string):void {
    const before = this.text;
    if (before === value) return;
    let from = 0;
    while (from < before.length && from < value.length && before[from] === value[from]) from++;
    let end = 0;
    while (end < before.length - from && end < value.length - from && before[before.length - 1 - end] === value[value.length - 1 - end]) end++;
    this.ydoc.transact(() => {
      if (before.length - end > from) this.ytext.delete(from, before.length - end - from);
      if (value.length - end > from) this.ytext.insert(from, value.slice(from, value.length - end));
    }, LOCAL_ORIGIN);
  }

  /** Automerge wins: if the two views ever disagree, Y.Text is rebuilt from Automerge. */
  private reconcile():void {
    const expected = typeof this.current.text === 'string' ? this.current.text : '';
    if (this.text === expected) return;
    console.warn('[Files] Live editor view drifted from Automerge; rebuilding it from Automerge.');
    this.ydoc.transact(() => this.replace(expected), AUTOMERGE_ORIGIN);
  }

  private replace(value:string):void { this.ytext.delete(0, this.ytext.length); this.ytext.insert(0, value) }

  destroy():void { this.undoManager.destroy(); this.ydoc.destroy() }
}

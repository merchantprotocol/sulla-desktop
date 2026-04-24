/**
 * Build a FilePatchInfo from an Edit (old_string → new_string) or a Write
 * (oldContent → newContent). The result matches the shape the renderer's
 * PatchMessage + PatchBlock.vue expects — hunks of add/remove/context lines
 * with new-side line numbers plus aggregate stat counts.
 *
 * Uses a standard LCS line-diff. No external dep. Good enough for edits
 * up to a few thousand lines — this is informational UI, not `git diff`.
 */

export type PatchOp = 'edit' | 'write';

export interface PatchLine {
  n:    number;            // 1-based line number on the new side (0 for pure removals)
  text: string;            // raw line text
  op:   'add' | 'remove' | 'context';
}

export interface PatchHunk {
  lines: PatchLine[];
}

export interface FilePatchInfo {
  path:    string;
  stat:    { added: number; removed: number };
  hunks:   PatchHunk[];
  /** Opaque metadata captured so the renderer can request a revert later. */
  revertMeta?: RevertMeta;
}

export type RevertMeta =
  | { op: 'edit';  path: string; oldString: string; newString: string }
  | { op: 'write'; path: string; oldContent: string };

const MAX_REVERT_BYTES = 512 * 1024;   // cap write-revert snapshots at 512 KB
const CONTEXT_LINES    = 2;            // show N context lines around each hunk

export function buildEditPatch(filePath: string, oldString: string, newString: string): FilePatchInfo {
  const info = diffStrings(filePath, oldString, newString);
  info.revertMeta = { op: 'edit', path: filePath, oldString, newString };
  return info;
}

export function buildWritePatch(filePath: string, oldContent: string, newContent: string): FilePatchInfo {
  const info = diffStrings(filePath, oldContent, newContent);
  if (oldContent.length <= MAX_REVERT_BYTES) {
    info.revertMeta = { op: 'write', path: filePath, oldContent };
  }
  return info;
}

function diffStrings(filePath: string, oldStr: string, newStr: string): FilePatchInfo {
  const oldLines = splitLines(oldStr);
  const newLines = splitLines(newStr);
  const ops = lcsDiff(oldLines, newLines);

  let added = 0;
  let removed = 0;
  let newLineNum = 0;

  // Convert the flat op stream into hunks (groups of changes + their context).
  // An "interesting" index is an add or remove; we walk the stream and emit
  // one hunk per run of interesting ops, padded on each side by CONTEXT_LINES.
  const annotated: { op: 'add' | 'remove' | 'context'; text: string; n: number }[] = [];
  for (const o of ops) {
    if (o.kind === 'context') {
      newLineNum++;
      annotated.push({ op: 'context', text: o.text, n: newLineNum });
    } else if (o.kind === 'add') {
      newLineNum++;
      added++;
      annotated.push({ op: 'add', text: o.text, n: newLineNum });
    } else {
      removed++;
      annotated.push({ op: 'remove', text: o.text, n: 0 });
    }
  }

  const interesting: boolean[] = annotated.map(a => a.op !== 'context');
  const hunks: PatchHunk[] = [];
  let i = 0;
  while (i < annotated.length) {
    if (!interesting[i]) { i++; continue; }
    // Walk back CONTEXT_LINES lines from i for leading context.
    const start = Math.max(0, i - CONTEXT_LINES);
    // Find the end of this hunk: the last interesting line, expanded
    // by CONTEXT_LINES of trailing context. Keep extending while the
    // next interesting line is within 2*CONTEXT_LINES — lets nearby
    // changes merge into one hunk instead of two.
    let lastInteresting = i;
    let j = i + 1;
    while (j < annotated.length) {
      if (interesting[j]) {
        lastInteresting = j;
        j++;
        continue;
      }
      let k = j;
      while (k < annotated.length && !interesting[k] && k - lastInteresting <= 2 * CONTEXT_LINES) k++;
      if (k < annotated.length && interesting[k]) {
        j = k;
        continue;
      }
      break;
    }
    const end = Math.min(annotated.length, lastInteresting + 1 + CONTEXT_LINES);
    hunks.push({ lines: annotated.slice(start, end) });
    i = end;
  }

  return {
    path: filePath,
    stat: { added, removed },
    hunks,
  };
}

function splitLines(s: string): string[] {
  if (s === '') return [];
  // Preserve the split — trailing newline produces an empty final element we drop
  const parts = s.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

type LineOp = { kind: 'context' | 'add' | 'remove'; text: string };

/**
 * Standard LCS → diff. O(n*m) space and time; acceptable for Edit fragments.
 * Returns ops in new-file order with removes interleaved at their original
 * position.
 */
function lcsDiff(a: string[], b: string[]): LineOp[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map(text => ({ kind: 'add' as const, text }));
  if (m === 0) return a.map(text => ({ kind: 'remove' as const, text }));

  // dp[i][j] = LCS length of a[0..i] and b[0..j]
  const dp: Uint32Array[] = new Array(n + 1);
  for (let i = 0; i <= n; i++) dp[i] = new Uint32Array(m + 1);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = dp[i - 1][j] >= dp[i][j - 1] ? dp[i - 1][j] : dp[i][j - 1];
    }
  }

  const ops: LineOp[] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      ops.push({ kind: 'context', text: a[i - 1] });
      i--; j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      ops.push({ kind: 'remove', text: a[i - 1] });
      i--;
    } else {
      ops.push({ kind: 'add', text: b[j - 1] });
      j--;
    }
  }
  while (i > 0) { ops.push({ kind: 'remove', text: a[i - 1] }); i--; }
  while (j > 0) { ops.push({ kind: 'add',    text: b[j - 1] }); j--; }
  ops.reverse();
  return ops;
}

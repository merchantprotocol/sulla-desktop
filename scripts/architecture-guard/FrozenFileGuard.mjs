// SPDX-License-Identifier: GPL-2.0-or-later
//
// Frozen files (architecture-guard rule `frozen`). A frozen file is legacy code that stays in
// service until its replacement lands and takes bug fixes only. Its entry in
// architecture-guard.config.json under "frozen" pins:
//   maxLines    the size budget; the file may not grow past it
//   exports     the exported names; the file may not export anything else
//   exceptions  the only way to raise either: one dated, approved entry per raise (see ARCHITECTURE-GUARD.md)
//
// Against the PR base (GUARD_BASE_REF) it also fails when a PR raises a budget or adds an export
// without adding an exception, or drops a frozen entry while the file still exists.

const DECLARED_EXPORT = /^export\s+(?:declare\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:class|function\s*\*?|const|let|var|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/gm;
const EXPORT_LIST = /^export\s+(?:type\s+)?\{([^}]*)\}/gm;
const EXPORT_STAR = /^export\s+(?:type\s+)?\*(?:\s+as\s+([A-Za-z_$][\w$]*))?/gm;
const ANONYMOUS_DEFAULT = /^export\s+default\s+(?!(?:abstract\s+)?(?:async\s+)?(?:class|function)\s+[A-Za-z_$])/gm;

export class FrozenFileGuard {
  /**
   * @param {{ exists(file: string): boolean, read(file: string): string, code(src: string): string }} source
   *   `code` returns the source with comments and string contents blanked (guard.mjs's stripper).
   */
  constructor(source) {
    this.source = source;
  }

  /** Names a module exports, from comment/string-stripped code. `*` marks an unnamed `export *`. */
  exportedNames(code) {
    const names = new Set();
    for (const m of code.matchAll(DECLARED_EXPORT)) names.add(m[1]);
    for (const m of code.matchAll(EXPORT_LIST)) {
      for (const part of m[1].split(',')) {
        const spec = part.trim().replace(/^type\s+/, '');
        if (!spec) continue;
        const alias = spec.split(/\s+as\s+/);
        names.add(alias[alias.length - 1].trim());
      }
    }
    for (const m of code.matchAll(EXPORT_STAR)) names.add(m[1] || '*');
    if (ANONYMOUS_DEFAULT.test(code)) names.add('default');
    ANONYMOUS_DEFAULT.lastIndex = 0;
    return [...names].sort();
  }

  /**
   * @param {Record<string, FrozenEntry>} frozen      this branch's entries
   * @param {Record<string, FrozenEntry> | null} base the PR base's entries (null: no base to compare)
   * @returns {{ errors: string[], warnings: string[] }}
   */
  check(frozen, base = null) {
    const errors = [];
    const warnings = [];
    for (const [file, entry] of Object.entries(frozen || {})) {
      errors.push(...this.entryProblems(file, entry));
      if (!this.source.exists(file)) {
        errors.push(`${file}: [frozen] file is gone. Remove its "frozen" entry from architecture-guard.config.json in the same PR.`);
        continue;
      }
      const src = this.source.read(file);
      const lines = this.lineCount(src);
      if (lines > entry.maxLines) {
        errors.push(`${file}: [frozen] ${lines} lines, budget ${entry.maxLines}. Frozen files take bug fixes only and may not grow; put new code in its replacement, or record an exception (ARCHITECTURE-GUARD.md).`);
      } else if (lines < entry.maxLines) {
        warnings.push(`${file}: [frozen] now ${lines} lines; you may lower maxLines from ${entry.maxLines}.`);
      }
      const allowed = new Set(entry.exports);
      const names = this.exportedNames(this.source.code(src));
      const added = names.filter(name => !allowed.has(name));
      if (added.length) {
        errors.push(`${file}: [frozen] new export(s) ${added.join(', ')}. Frozen files may not gain exports; export from the replacement instead, or record an exception (ARCHITECTURE-GUARD.md).`);
      }
      const dropped = entry.exports.filter(name => !names.includes(name));
      if (dropped.length) warnings.push(`${file}: [frozen] no longer exports ${dropped.join(', ')}; you may drop them from its exports list.`);
    }
    if (base) errors.push(...this.baseProblems(frozen || {}, base));
    return { errors, warnings };
  }

  /** Lines as an editor or `wc -l` counts them (a trailing newline does not start a new line). */
  lineCount(src) {
    if (!src) return 0;
    const parts = src.split('\n').length;
    return src.endsWith('\n') ? parts - 1 : parts;
  }

  entryProblems(file, entry) {
    const problems = [];
    if (!Number.isInteger(entry?.maxLines) || entry.maxLines < 1) problems.push(`${file}: [frozen] maxLines must be a positive integer.`);
    if (!Array.isArray(entry?.exports)) problems.push(`${file}: [frozen] exports must be a list of names.`);
    if (typeof entry?.reason !== 'string' || !entry.reason.trim()) problems.push(`${file}: [frozen] reason is required.`);
    for (const [i, ex] of (entry?.exceptions || []).entries()) {
      for (const key of ['date', 'reason', 'approvedBy']) {
        if (typeof ex?.[key] !== 'string' || !ex[key].trim()) problems.push(`${file}: [frozen] exceptions[${i}].${key} is required.`);
      }
    }
    return problems;
  }

  baseProblems(frozen, base) {
    const problems = [];
    for (const [file, was] of Object.entries(base)) {
      const now = frozen[file];
      if (!now) {
        if (this.source.exists(file)) problems.push(`${file}: [frozen] the PR unfreezes a file that still exists. Delete the file (its replacement has landed) or keep it frozen.`);
        continue;
      }
      const raisedLines = now.maxLines > was.maxLines;
      const newExports = (now.exports || []).filter(name => !(was.exports || []).includes(name));
      if (!raisedLines && !newExports.length) continue;
      const before = (was.exceptions || []).length;
      const after = (now.exceptions || []).length;
      if (after <= before) {
        const what = [raisedLines ? `maxLines ${was.maxLines} -> ${now.maxLines}` : '', newExports.length ? `exports + ${newExports.join(', ')}` : ''].filter(Boolean).join('; ');
        problems.push(`${file}: [frozen] budget raised (${what}) without a new exceptions entry. Add one (date, reason, approvedBy) or keep the budget.`);
      }
    }
    return problems;
  }
}

/** @typedef {{ reason: string, maxLines: number, exports: string[], until?: string, exceptions?: Array<{ date: string, reason: string, approvedBy: string, pr?: string }> }} FrozenEntry */

// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Finds SQL reads on the large Files tables that can return a row per file/version
 * with no bound. A read is bounded when it has a LIMIT, is keyed to one row
 * (id / file_id / version_id equality), is an EXISTS probe, or only aggregates.
 */
export class UnboundedReadGuard {
  static readonly bigTables = ['files', 'file_versions', 'file_folders', 'files_cloud_file_heads', 'file_automerge_versions'];

  /** String and template literals that contain a SELECT. */
  static selects(source:string):string[] {
    const found:string[] = [];
    const literal = /`(?:\\[\s\S]|[^`\\])*`|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g;
    for (const match of source.matchAll(literal)) {
      if (/\bSELECT\b/i.test(match[0])) found.push(match[0].slice(1, -1));
    }
    return found;
  }

  static isUnbounded(sql:string):boolean {
    const text = sql.replace(/\s+/g, ' ');
    const tables = UnboundedReadGuard.bigTables.join('|');
    // Strip EXISTS(...) probes: they stop at the first row.
    const outer = text.replace(/EXISTS\s*\(\s*SELECT 1[^()]*(\([^()]*\)[^()]*)*\)/gi, 'TRUE');
    if (!new RegExp(`\\b(FROM|JOIN)\\s+(${ tables })\\b`, 'i').test(outer)) return false;
    if (/\bLIMIT\b/i.test(outer)) return false;
    // One row by key.
    if (/\b(\w+\.)?(id|file_id|version_id|current_version_id)\s*=\s*\$\d+/i.test(outer)) return false;
    // (collection_id, path) is unique for files and folders.
    if (/\bcollection_id\s*=\s*\$\d+\s+AND\s+(\w+\.)?path\s*=\s*\$\d+(?!\s*OR)/i.test(outer)) return false;
    // Bounded by the caller's id array (one row per supplied key).
    if (/\b(\w+\.)?(id|file_id|version_id)\s*=\s*ANY\s*\(\s*\$\d+/i.test(outer)) return false;
    // Aggregate-only projection returns one row.
    if (/^\s*SELECT\s+(COUNT|MAX|MIN|SUM|COALESCE\s*\(\s*(SUM|MAX|MIN|COUNT)|GREATEST|bool_or|bool_and)\b/i.test(outer) && !/\bGROUP BY\b/i.test(outer)) return false;
    // Writes that only read through RETURNING / INSERT ... SELECT are out of scope.
    if (/^\s*(INSERT|UPDATE|DELETE|WITH\s+\w+\s+AS\s*\(\s*(UPDATE|DELETE|INSERT))/i.test(outer)) return false;
    return true;
  }

  static count(source:string):number {
    return UnboundedReadGuard.selects(source).filter(sql => UnboundedReadGuard.isUnbounded(sql)).length;
  }
}

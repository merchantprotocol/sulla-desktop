// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { MappedToolCardFormatter } from './MappedToolCardFormatter';
import { ToolCardText } from './ToolCardText';
export class DatabaseToolCardFormatter extends MappedToolCardFormatter {
  constructor(text: ToolCardText) {
    super({
  pg_query(args) {
    const sql = text.string(args.sql || args.query || args.statement);
    return { label: 'Database', summary: `Querying: ${ text.truncate(sql, 70) }`, input: sql || undefined, outputFormat: 'json' };
  },
  pg_queryall(args) {
    const sql = text.string(args.sql);
    return { label: 'Database', summary: `Querying all: ${ text.truncate(sql, 65) }`, input: sql || undefined, outputFormat: 'json' };
  },
  pg_queryone(args) {
    const sql = text.string(args.sql);
    return { label: 'Database', summary: `Querying one: ${ text.truncate(sql, 65) }`, input: sql || undefined, outputFormat: 'json' };
  },
  pg_execute(args) {
    const sql = text.string(args.sql || args.query || args.statement);
    return { label: 'Database', summary: `Executing: ${ text.truncate(sql, 68) }`, input: sql || undefined };
  },
  pg_count(args) {
    const sql = text.string(args.sql);
    return { label: 'Database', summary: `Counting: ${ text.truncate(sql, 68) }`, input: sql || undefined };
  },
  pg_transaction(args) {
    return { label: 'Database', summary: 'Running transaction', input: text.truncate(text.string(args.sql), 80) || undefined };
  },
    });
  }
}

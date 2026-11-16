// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Quotes a lower-case PostgreSQL identifier after proving it cannot inject SQL. */
export class SqlIdentifier {
  static quote(value:string):string {
    if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error(`Unsafe PostgreSQL identifier: ${ value }`);
    return `"${ value }"`;
  }

  /** `public."name"` for a table owned by the Files schema. */
  static publicTable(value:string):string { return `public.${ SqlIdentifier.quote(value) }` }
}

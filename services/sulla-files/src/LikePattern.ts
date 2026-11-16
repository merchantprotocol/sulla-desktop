// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Literal text turned into a Postgres LIKE pattern. `%`, `_` and the escape character `\` in the
 * literal are escaped, so a folder named `a_b` or `50%` matches only itself, never a sibling.
 * Pair every pattern with `LIKE $n ESCAPE '\'` (the explicit form of Postgres' default escape).
 */
export class LikePattern {
  static readonly escapeCharacter = '\\';

  /** The literal with LIKE wildcards and the escape character escaped. */
  static escape(literal:string):string { return literal.replace(/[\\%_]/g, '\\$&') }

  /** Matches text that starts with the literal. */
  static prefix(literal:string):string { return `${ LikePattern.escape(literal) }%` }

  /** Matches text that contains the literal anywhere. */
  static contains(literal:string):string { return `%${ LikePattern.escape(literal) }%` }
}

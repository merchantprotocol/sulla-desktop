/**
 * datePrefix — render a `created_at` value as a stable `YYYY-MM-DD` prefix.
 *
 * Postgres `TIMESTAMPTZ` columns are TYPED as `string` on our model records,
 * but node-postgres hydrates them into JS `Date` objects at runtime. Any code
 * that assumed a string and called `value.slice(0, 10)` therefore threw
 * `slice is not a function` the moment a row actually existed — silently
 * killing observation injection (the primary path fell through to an empty
 * legacy fallback) and breaking `list_identity_observations`.
 *
 * This is the single source of truth for that formatting so every read path —
 * prompt sections, recall middleware, and the list tools — handles Date,
 * string, and null identically.
 */
export function datePrefix(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'string') return value.slice(0, 10);
  return '';
}

/**
 * Derive a URL/path-safe kebab-case slug from a human project name.
 *
 * Keeps directories, slugs, and URLs free of spaces and punctuation that
 * break shell scripts, file paths, and CI pipelines (see issue #43). The
 * human-friendly name is preserved separately as the project `title`.
 *
 * Mirrors the routine-export slugify convention used elsewhere in the app.
 */
export function slugify(input: string): string {
  const slug = String(input || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug || 'project';
}

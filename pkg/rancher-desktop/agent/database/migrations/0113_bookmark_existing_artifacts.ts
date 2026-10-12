// One-time backfill: every existing chat artifact gets a bookmark in the
// "Artifacts" folder. New artifacts are bookmarked by ArtifactBookmarkSync as
// they are created. Running this once (not on every boot) means bookmarks the
// user deletes stay deleted. Deterministic ids + ON CONFLICT keep it safe.
export const up = `
INSERT INTO browser_bookmarks (id, parent_id, kind, title, url, favicon, position)
SELECT 'sulla-artifacts', NULL, 'folder', 'Artifacts', NULL, NULL,
       (SELECT COALESCE(MAX(position), 0) + 1 FROM browser_bookmarks WHERE parent_id IS NULL)
 WHERE EXISTS (SELECT 1 FROM chat_artifacts WHERE is_deleted = false)
ON CONFLICT (id) DO NOTHING;

INSERT INTO browser_bookmarks (id, parent_id, kind, title, url, favicon, position)
SELECT 'bm_art_' || md5(a.id), 'sulla-artifacts', 'bookmark', LEFT(a.name, 500),
       'sulla-artifact://' || a.id, NULL,
       ROW_NUMBER() OVER (ORDER BY a.created_at DESC, a.id)
  FROM chat_artifacts a
 WHERE a.is_deleted = false
   AND EXISTS (SELECT 1 FROM browser_bookmarks f WHERE f.id = 'sulla-artifacts' AND f.kind = 'folder')
   AND NOT EXISTS (SELECT 1 FROM browser_bookmarks b WHERE b.url = 'sulla-artifact://' || a.id)
ON CONFLICT (id) DO NOTHING;
`;

export const down = `
DELETE FROM browser_bookmarks WHERE id LIKE 'bm_art_%';
`;

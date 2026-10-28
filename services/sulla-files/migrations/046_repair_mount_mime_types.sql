-- SPDX-License-Identifier: GPL-2.0-or-later
-- Files written through the Files mount were stored as application/octet-stream
-- (the adapter never sends a type) or text/plain (empty creates), so images,
-- video, audio and documents showed as plain files with no preview. New writes
-- now take the type from the extension (mimeTypes.ts resolveMime); this fixes
-- rows already stored. Only generic/text rows with a known non-text extension
-- change, and retention-locked files are left alone (their mime is frozen).
WITH fixes(ext, mime) AS (VALUES
  ('png','image/png'),('jpg','image/jpeg'),('jpeg','image/jpeg'),('gif','image/gif'),('webp','image/webp'),
  ('mp3','audio/mpeg'),('wav','audio/wav'),('m4a','audio/mp4'),('aac','audio/aac'),('flac','audio/flac'),
  ('ogg','audio/ogg'),('opus','audio/opus'),('aif','audio/aiff'),('aiff','audio/aiff'),('weba','audio/webm'),
  ('mp4','video/mp4'),('mov','video/quicktime'),('webm','video/webm'),('mkv','video/x-matroska'),
  ('pdf','application/pdf'),('doc','application/msword'),
  ('docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
  ('xls','application/vnd.ms-excel'),('xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
  ('ppt','application/vnd.ms-powerpoint'),('pptx','application/vnd.openxmlformats-officedocument.presentationml.presentation')
)
UPDATE files f SET mime = fixes.mime
  FROM fixes
 WHERE lower(substring(f.path from '\.([^./]+)$')) = fixes.ext
   AND f.mime IN ('application/octet-stream', 'text/plain')
   AND f.deleted_at IS NULL
   AND NOT files_retention_active(f);

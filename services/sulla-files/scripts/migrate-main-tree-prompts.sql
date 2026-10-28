-- SPDX-License-Identifier: GPL-2.0-or-later
-- Apply after a database backup when the Sulla collection migration has completed.
-- Idempotently updates only rows whose stored prompt still names the retired Sulla/ prefix.
UPDATE agent_definitions
SET system_prompt = replace(replace(replace(replace(replace(system_prompt,
  'Sulla/Projects/', 'Projects/'), 'Sulla/Memory/', 'Memory/'), 'Sulla/Use Cases/', 'Use Cases/'), 'Sulla/Docs/', 'Docs/'), 'Sulla/Identity/', 'Identity/')
WHERE system_prompt LIKE '%Sulla/Projects/%' OR system_prompt LIKE '%Sulla/Memory/%' OR system_prompt LIKE '%Sulla/Use Cases/%'
   OR system_prompt LIKE '%Sulla/Docs/%' OR system_prompt LIKE '%Sulla/Identity/%';

UPDATE agent_definitions
SET soul_content = replace(replace(replace(replace(replace(soul_content,
  'Sulla/Projects/', 'Projects/'), 'Sulla/Memory/', 'Memory/'), 'Sulla/Use Cases/', 'Use Cases/'), 'Sulla/Docs/', 'Docs/'), 'Sulla/Identity/', 'Identity/')
WHERE soul_content LIKE '%Sulla/Projects/%' OR soul_content LIKE '%Sulla/Memory/%' OR soul_content LIKE '%Sulla/Use Cases/%'
   OR soul_content LIKE '%Sulla/Docs/%' OR soul_content LIKE '%Sulla/Identity/%';

UPDATE sulla_system_prompt_sections
SET content = replace(replace(replace(replace(replace(content,
  'Sulla/Projects/', 'Projects/'), 'Sulla/Memory/', 'Memory/'), 'Sulla/Use Cases/', 'Use Cases/'), 'Sulla/Docs/', 'Docs/'), 'Sulla/Identity/', 'Identity/')
WHERE content LIKE '%Sulla/Projects/%' OR content LIKE '%Sulla/Memory/%' OR content LIKE '%Sulla/Use Cases/%'
   OR content LIKE '%Sulla/Docs/%' OR content LIKE '%Sulla/Identity/%';

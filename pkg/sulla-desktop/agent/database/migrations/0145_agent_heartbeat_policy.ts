// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Seed policy only when absent; JSONB merge preserves every existing config key. */
export const up = `
  UPDATE agent_definitions AS a
  SET config = COALESCE(a.config, '{}'::jsonb) || jsonb_build_object('heartbeat', jsonb_build_object('allowed', v.allowed, 'defaultIntervalMinutes', 5, 'minIntervalMinutes', 1, 'maxIntervalMinutes', 1440))
  FROM (VALUES
    ('sulla', true), ('sulla-desktop', true),
    ('account-manager', true), ('coding-manager', true), ('coding-manager-sol', true),
    ('coding-manager-gpt', true), ('coding-manager-grok', true), ('ui-test-manager', true),
    ('project-manager', true), ('director', true), ('heartbeat', true),
    ('codex-sol-worker', false), ('codex-luna-worker', false), ('codex-gpt-worker', false),
    ('codex-grok-worker', false), ('sonnet-worker', false), ('haiku-worker', false),
    ('opus-worker', false), ('test-implementer', false), ('mockup-designer', false), ('analytics-worker', false)
  ) AS v(slug, allowed)
  WHERE a.slug = v.slug AND NOT (COALESCE(a.config, '{}'::jsonb) ? 'heartbeat');
`;

/** Remove only the exact seed value; never erase a human-edited policy. */
export const down = `
  UPDATE agent_definitions AS a
  SET config = a.config - 'heartbeat'
  FROM (VALUES
    ('sulla', true), ('sulla-desktop', true),
    ('account-manager', true), ('coding-manager', true), ('coding-manager-sol', true),
    ('coding-manager-gpt', true), ('coding-manager-grok', true), ('ui-test-manager', true),
    ('project-manager', true), ('director', true), ('heartbeat', true),
    ('codex-sol-worker', false), ('codex-luna-worker', false), ('codex-gpt-worker', false),
    ('codex-grok-worker', false), ('sonnet-worker', false), ('haiku-worker', false),
    ('opus-worker', false), ('test-implementer', false), ('mockup-designer', false), ('analytics-worker', false)
  ) AS v(slug, allowed)
  WHERE a.slug = v.slug
    AND a.config->'heartbeat' = jsonb_build_object('allowed', v.allowed, 'defaultIntervalMinutes', 5, 'minIntervalMinutes', 1, 'maxIntervalMinutes', 1440);
`;

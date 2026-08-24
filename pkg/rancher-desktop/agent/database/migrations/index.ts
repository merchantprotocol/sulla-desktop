import { up as up_0001, down as down_0001 } from './0001_create_migrations_and_seeders_table';
import { up as up_0002, down as down_0002 } from './0002_create_agent_awareness_table';
import { up as up_0008, down as down_0008 } from './0008_create_calendar_events_table';
import { up as up_0009, down as down_0009 } from './0009_add_status_to_calendar_events';
import { up as up_0010, down as down_0010 } from './0010_create_sections_and_categories_tables';
import { up as up_0011, down as down_0011 } from './0011_create_settings_table';
import { up as up_0012, down as down_0012 } from './0012_add_cast_column_to_sulla_settings';
import { up as up_0013, down as down_0013 } from './0013_create_integration_values_table';
import { up as up_0014, down as down_0014 } from './0014_add_is_default_to_integration_values';
import { up as up_0016, down as down_0016 } from './0016_create_oauth_tokens_table';
import { up as up_0017, down as down_0017 } from './0017_create_workflow_checkpoints_table';
import { up as up_0018, down as down_0018 } from './0018_create_workflow_pending_completions_table';
import { up as up_0019, down as down_0019 } from './0019_create_conversation_history_table';
import { up as up_0020, down as down_0020 } from './0020_create_claude_conversations_table';
import { up as up_0021, down as down_0021 } from './0021_create_claude_messages_table';
import { up as up_0022, down as down_0022 } from './0022_create_sync_queue_table';
import { up as up_0023, down as down_0023 } from './0023_create_workflows_table';
import { up as up_0024, down as down_0024 } from './0024_add_source_template_slug_to_workflows';
import { up as up_0025, down as down_0025 } from './0025_create_library_drafts_table';
import { up as up_0026, down as down_0026 } from './0026_create_workflow_executions_table';
import { up as up_0027, down as down_0027 } from './0027_create_audit_history_tables';
import { up as up_0028, down as down_0028 } from './0028_create_observations_table';
// NOTE: numbered 0037+ (not 0029-0032) to sit AFTER the CRM dynamic-schema
// migrations 0029-0036 that production has already executed. See commit message /
// docs/MIGRATION_NOTES.md §7 for the collision-resolution rationale.
import { up as up_0029, down as down_0029 } from './0029_create_knowledge_graph';
import { up as up_0037, down as down_0037 } from './0037_create_routine_stewardship_views';
import { up as up_0038, down as down_0038 } from './0038_create_routine_digest_views';
import { up as up_0039, down as down_0039 } from './0039_create_routine_promotion_candidates_view';
import { up as up_0040, down as down_0040 } from './0040_create_heartbeat_seen_issues_table';
import { up as up_0041, down as down_0041 } from './0041_add_trigram_index_to_observations';
import { up as up_0042, down as down_0042 } from './0042_create_rules_table';
import { up as up_0043, down as down_0043 } from './0043_create_agent_jobs_table';
import { up as up_0044, down as down_0044 } from './0044_create_work_items_tables';
import { up as up_0045, down as down_0045 } from './0045_bound_stale_routine_digest_failures';
import { up as up_0046, down as down_0046 } from './0046_create_heartbeat_run_audit_table';
import { up as up_0047, down as down_0047 } from './0047_add_work_task_actor';
import { up as up_0048, down as down_0048 } from './0048_create_system_prompt_sections_table';
import { up as up_0049, down as down_0049 } from './0049_create_system_prompt_section_edits_table';
import { up as up_0050, down as down_0050 } from './0050_create_identity_observations_table';
import { up as up_0051, down as down_0051 } from './0051_constrain_identity_observation_domains';
import { up as up_0052, down as down_0052 } from './0052_add_self_observation_fields';
import { up as up_0053, down as down_0053 } from './0053_allow_environment_identity_domain';
import { up as up_0054, down as down_0054 } from './0054_allow_projects_identity_domain';
import { up as up_0055, down as down_0055 } from './0055_add_system_and_content_hash_to_workflows';
import { up as up_0056, down as down_0056 } from './0056_fix_routine_scorecard_null_slug';
import { up as up_0057, down as down_0057 } from './0057_create_conversation_keywords_table';
import { up as up_0058, down as down_0058 } from './0058_add_hidden_to_conversation_history';
import { up as up_0059, down as down_0059 } from './0059_allow_skills_identity_domain';
import { up as up_0060, down as down_0060 } from './0060_add_skill_slug_to_identity_observations';
import { up as up_0061, down as down_0061 } from './0061_add_work_task_activity';
import { up as up_0062, down as down_0062 } from './0062_create_work_task_dispatches';
import { up as up_0068, down as down_0068 } from './0068_create_lifecycle_capabilities';

export const migrationsRegistry = [
  { name: '0001_create_migrations_and_seeders_table', up: up_0001, down: down_0001 },
  { name: '0002_create_agent_awareness_table', up: up_0002, down: down_0002 },
  { name: '0008_create_calendar_events_table', up: up_0008, down: down_0008 },
  { name: '0009_add_status_to_calendar_events', up: up_0009, down: down_0009 },
  { name: '0010_create_sections_and_categories_tables', up: up_0010, down: down_0010 },
  { name: '0011_create_settings_table', up: up_0011, down: down_0011 },
  { name: '0012_add_cast_column_to_sulla_settings', up: up_0012, down: down_0012 },
  { name: '0013_create_integration_values_table', up: up_0013, down: down_0013 },
  { name: '0014_add_is_default_to_integration_values', up: up_0014, down: down_0014 },
  { name: '0016_create_oauth_tokens_table', up: up_0016, down: down_0016 },
  { name: '0017_create_workflow_checkpoints_table', up: up_0017, down: down_0017 },
  { name: '0018_create_workflow_pending_completions_table', up: up_0018, down: down_0018 },
  { name: '0019_create_conversation_history_table', up: up_0019, down: down_0019 },
  { name: '0020_create_claude_conversations_table', up: up_0020, down: down_0020 },
  { name: '0021_create_claude_messages_table', up: up_0021, down: down_0021 },
  { name: '0022_create_sync_queue_table', up: up_0022, down: down_0022 },
  { name: '0023_create_workflows_table', up: up_0023, down: down_0023 },
  { name: '0024_add_source_template_slug_to_workflows', up: up_0024, down: down_0024 },
  { name: '0025_create_library_drafts_table', up: up_0025, down: down_0025 },
  { name: '0026_create_workflow_executions_table', up: up_0026, down: down_0026 },
  { name: '0027_create_audit_history_tables', up: up_0027, down: down_0027 },
  { name: '0028_create_observations_table',   up: up_0028, down: down_0028 },
  { name: '0029_create_knowledge_graph',               up: up_0029, down: down_0029 },
  { name: '0037_create_routine_stewardship_views',          up: up_0037, down: down_0037 },
  { name: '0038_create_routine_digest_views',               up: up_0038, down: down_0038 },
  { name: '0039_create_routine_promotion_candidates_view',  up: up_0039, down: down_0039 },
  { name: '0040_create_heartbeat_seen_issues_table',        up: up_0040, down: down_0040 },
  { name: '0041_add_trigram_index_to_observations',         up: up_0041, down: down_0041 },
  { name: '0042_create_rules_table',                        up: up_0042, down: down_0042 },
  { name: '0043_create_agent_jobs_table',                   up: up_0043, down: down_0043 },
  { name: '0044_create_work_items_tables',                   up: up_0044, down: down_0044 },
  { name: '0045_bound_stale_routine_digest_failures',        up: up_0045, down: down_0045 },
  { name: '0046_create_heartbeat_run_audit_table',            up: up_0046, down: down_0046 },
  { name: '0047_add_work_task_actor',                          up: up_0047, down: down_0047 },
  { name: '0048_create_system_prompt_sections_table',          up: up_0048, down: down_0048 },
  { name: '0049_create_system_prompt_section_edits_table',      up: up_0049, down: down_0049 },
  { name: '0050_create_identity_observations_table',            up: up_0050, down: down_0050 },
  { name: '0051_constrain_identity_observation_domains',         up: up_0051, down: down_0051 },
  { name: '0052_add_self_observation_fields',                    up: up_0052, down: down_0052 },
  { name: '0053_allow_environment_identity_domain',              up: up_0053, down: down_0053 },
  { name: '0054_allow_projects_identity_domain',                 up: up_0054, down: down_0054 },
  { name: '0055_add_system_and_content_hash_to_workflows',       up: up_0055, down: down_0055 },
  { name: '0056_fix_routine_scorecard_null_slug',                 up: up_0056, down: down_0056 },
  { name: '0057_create_conversation_keywords_table',              up: up_0057, down: down_0057 },
  { name: '0058_add_hidden_to_conversation_history',               up: up_0058, down: down_0058 },
  { name: '0059_allow_skills_identity_domain',                    up: up_0059, down: down_0059 },
  { name: '0060_add_skill_slug_to_identity_observations',         up: up_0060, down: down_0060 },
  { name: '0061_add_work_task_activity',                           up: up_0061, down: down_0061 },
  { name: '0062_create_work_task_dispatches',                      up: up_0062, down: down_0062 },
  { name: '0068_create_lifecycle_capabilities',                    up: up_0068, down: down_0068 },
] as const;

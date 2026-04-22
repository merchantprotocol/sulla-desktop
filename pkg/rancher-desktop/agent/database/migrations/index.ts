// migrations/index.ts stays the same (re-exports)
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
] as const;

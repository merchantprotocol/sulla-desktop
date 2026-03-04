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
import { up as up_0015, down as down_0015 } from './0015_add_disabled_to_workflow_history';
import { up as up_0016, down as down_0016 } from './0016_create_oauth_tokens_table';

export const migrationsRegistry = [
  { name: '0001_create_migrations_and_seeders_table', up: up_0001, down: down_0001 },
  { name: '0002_create_agent_awareness_table',      up: up_0002, down: down_0002 },
  { name: '0008_create_calendar_events_table', up: up_0008, down: down_0008 },
  { name: '0009_add_status_to_calendar_events', up: up_0009, down: down_0009 },
  { name: '0010_create_sections_and_categories_tables', up: up_0010, down: down_0010 },
  { name: '0011_create_settings_table', up: up_0011, down: down_0011 },
  { name: '0012_add_cast_column_to_sulla_settings', up: up_0012, down: down_0012 },
  { name: '0013_create_integration_values_table', up: up_0013, down: down_0013 },
  { name: '0014_add_is_default_to_integration_values', up: up_0014, down: down_0014 },
  { name: '0015_add_disabled_to_workflow_history', up: up_0015, down: down_0015 },
  { name: '0016_create_oauth_tokens_table', up: up_0016, down: down_0016 },
] as const;
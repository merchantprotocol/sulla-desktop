// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { formatToolCard as legacyCard, formatToolResult as legacyResult } from './toolCardDefinitions';

export interface ToolCardDisplay {
  label: string;
  summary: string;
  input?: string;
  output?: string;
  outputFormat?: 'text' | 'code' | 'url' | 'json';
}
export type ToolArguments = Record<string, unknown>;
export interface ToolCardFormatter { supports(toolName: string): boolean; format(args: ToolArguments, result?: unknown): Partial<ToolCardDisplay> }

export class ToolArgumentRedactor {
  private readonly secretFields = new Map<string, string[]>([
    ['vault_create_password', ['password']], ['vault_update_password', ['password']], ['vault_set_credential', ['value']],
  ]);
  redact(toolName: string, args: unknown): unknown {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
    const fields = this.secretFields.get(toolName) ?? this.secretFields.get(toolName.replace(/^vault\//, 'vault_'));
    if (!fields) return args;
    const safe = { ...(args as ToolArguments) };
    for (const field of fields) if (field in safe) safe[field] = '[REDACTED]';
    return safe;
  }
}

class ExactToolCardFormatter implements ToolCardFormatter {
  constructor(private readonly name: string) {}
  supports(toolName: string): boolean { return toolName === this.name; }
  format(args: ToolArguments, result?: unknown): Partial<ToolCardDisplay> { return legacyCard(this.name, args, result); }
}

export class PrefixToolCardFormatter implements ToolCardFormatter {
  constructor(private readonly prefix: string, private readonly label: string) {}
  supports(toolName: string): boolean { return toolName.startsWith(this.prefix); }
  format(args: ToolArguments, result?: unknown): Partial<ToolCardDisplay> { return legacyCard(this.prefix, args, result); }
  get displayLabel(): string { return this.label; }
}

export class ToolCardFormatterRegistry {
  constructor(private readonly exact: ToolCardFormatter[] = [], private readonly prefixes: ToolCardFormatter[] = []) {}
  resolve(toolName: string): ToolCardFormatter | undefined {
    return this.exact.find(formatter => formatter.supports(toolName)) ?? this.prefixes.find(formatter => formatter.supports(toolName));
  }
  format(toolName: string, args: ToolArguments, result?: unknown): ToolCardDisplay {
    const formatter = this.resolve(toolName);
    return formatter ? { ...formatter.format(args, result), label: formatter.format(args, result).label ?? this.fallbackLabel(toolName), summary: formatter.format(args, result).summary ?? toolName } : legacyCard(toolName, args, result);
  }
  formatResult(toolName: string, args: ToolArguments, result: unknown): { output?: string; outputFormat?: ToolCardDisplay['outputFormat'] } { return legacyResult(toolName, args, result); }
  private fallbackLabel(toolName: string): string { return this.prefixes.find(formatter => formatter.supports(toolName) && 'displayLabel' in formatter) instanceof PrefixToolCardFormatter ? (this.prefixes.find(formatter => formatter.supports(toolName)) as PrefixToolCardFormatter).displayLabel : 'Tool'; }
}

export class ToolCardPresenter {
  constructor(private readonly registry: ToolCardFormatterRegistry) {}
  formatToolCard(toolName: string, args: ToolArguments, result?: unknown): ToolCardDisplay { return this.registry.format(toolName, args, result); }
  formatToolResult(toolName: string, args: ToolArguments, result: unknown, _error?: string | null) { return this.registry.formatResult(toolName, args, result); }
}

const exactNames = ['exec', 'exec_command', 'shell', 'bash', 'run_command', 'exechost', 'file_search', 'read_file', 'browser_tab', 'click_element', 'set_field', 'get_page_snapshot', 'get_page_text', 'get_form_values', 'scroll_to_element', 'wait_for_element', 'git_status', 'git_commit', 'git_push', 'git_pull', 'git_diff', 'git_log', 'git_add', 'git_branch', 'git_checkout', 'git_stash', 'git_blame', 'git_conflicts', 'github_create_pr', 'github_create_issue', 'github_get_issue', 'github_get_issues', 'github_read_file', 'github_create_file', 'github_update_file', 'github_comment_on_issue', 'github_close_issue', 'github_update_issue', 'github_list_branches', 'github_add_remote', 'github_init', 'docker_build', 'docker_run', 'docker_exec', 'docker_ps', 'docker_logs', 'docker_pull', 'docker_stop', 'docker_rm', 'docker_images', 'slack_send_message', 'slack_search_users', 'slack_update', 'slack_thread', 'slack_user', 'slack_unreact', 'slack_connection_health', 'pg_query', 'pg_queryall', 'pg_queryone', 'pg_execute', 'pg_count', 'pg_transaction', 'redis_get', 'redis_set', 'redis_del', 'redis_hget', 'redis_hgetall', 'redis_hset', 'redis_incr', 'redis_decr', 'redis_lpop', 'redis_rpush', 'redis_expire', 'redis_ttl', 'calendar_create', 'calendar_list', 'calendar_list_upcoming', 'calendar_get', 'calendar_update', 'calendar_cancel', 'calendar_delete', 'execute_workflow', 'validate_workflow', 'validate_workflow_payload', 'patch_workflow', 'diagnose_webhook', 'restart_from_checkpoint', 'install_extension', 'uninstall_extension', 'list_installed_extensions', 'list_extension_catalog', 'spawn_agent', 'check_agent_jobs', 'list_agents', 'agents_directory', 'send_notification_to_human', 'emit_html_message', 'update_human_presence', 'get_human_presence', 'add_observational_memory', 'remove_observational_memory', 'create_workspace', 'delete_workspace', 'get_workspace_path', 'view_workspace_files', 'create_skill', 'integration_list', 'vault_is_enabled', 'vault_read_secrets', 'vault_list_accounts', 'vault_set_active_account', 'vault_set_credential', 'vault_create_password', 'vault_generate_password', 'vault_update_password'];
const prefixes = [['fs_', 'Files'], ['git', 'Git'], ['github_', 'GitHub'], ['docker_', 'Docker'], ['kubectl_', 'Kubernetes'], ['pg_', 'Database'], ['redis_', 'Redis'], ['slack_', 'Slack'], ['calendar_', 'Calendar']] as const;
export class ToolCardCompositionRoot {
  readonly redactor = new ToolArgumentRedactor();
  readonly presenter = new ToolCardPresenter(new ToolCardFormatterRegistry(exactNames.map(name => new ExactToolCardFormatter(name)), prefixes.map(([prefix, label]) => new PrefixToolCardFormatter(prefix, label))));
}

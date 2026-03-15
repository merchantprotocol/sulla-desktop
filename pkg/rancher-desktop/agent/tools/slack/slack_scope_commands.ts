import { BaseTool, ToolResponse } from '../base';
import { registry } from '../../integrations';
import type { SlackClient } from '../../integrations/slack/SlackClient';

interface ScopeConfig {
  scope:       string;
  description: string;
}

const SCOPE_CONFIGS: ScopeConfig[] = [
  { scope: 'app_mentions:read', description: 'View messages that directly mention the app in conversations it has joined.' },
  { scope: 'bookmarks:read', description: 'List bookmarks.' },
  { scope: 'bookmarks:write', description: 'Create, edit, and remove bookmarks.' },
  { scope: 'calls:read', description: 'View information about ongoing and past calls.' },
  { scope: 'canvases:read', description: 'Access contents of Slack canvases.' },
  { scope: 'channels:history', description: 'View messages/content in public channels the app is in.' },
  { scope: 'channels:join', description: 'Join public channels in a workspace.' },
  { scope: 'channels:read', description: 'View basic information about public channels.' },
  { scope: 'channels:write.invites', description: 'Invite members to public channels.' },
  { scope: 'chat:write', description: 'Send messages as the app.' },
  { scope: 'chat:write.customize', description: 'Send messages with customized username/avatar.' },
  { scope: 'emoji:read', description: 'View custom emoji in a workspace.' },
  { scope: 'files:read', description: 'View files shared in channels/conversations the app is in.' },
  { scope: 'files:write', description: 'Upload, edit, and delete files as the app.' },
  { scope: 'groups:history', description: 'View messages/content in private channels the app is in.' },
  { scope: 'groups:read', description: 'View basic information about private channels the app is in.' },
  { scope: 'groups:write', description: 'Manage private channels and create new ones.' },
  { scope: 'groups:write.invites', description: 'Invite members to private channels.' },
  { scope: 'groups:write.topic', description: 'Set description/topic of private channels.' },
  { scope: 'im:history', description: 'View messages/content in direct messages the app is in.' },
  { scope: 'im:read', description: 'View basic information about direct messages.' },
  { scope: 'im:write', description: 'Start direct messages with people.' },
  { scope: 'im:write.topic', description: 'Set description/topic in direct messages.' },
  { scope: 'incoming-webhook', description: 'Post messages to specific channels via incoming webhooks.' },
  { scope: 'links.embed:write', description: 'Embed video player URLs in messages and app surfaces.' },
  { scope: 'links:read', description: 'View URLs in messages.' },
  { scope: 'lists:read', description: 'Access contents of Slack lists.' },
  { scope: 'metadata.message:read', description: 'Read message metadata in channels where the app is present.' },
  { scope: 'mpim:history', description: 'View messages/content in group direct messages.' },
  { scope: 'mpim:read', description: 'View basic information about group direct messages.' },
  { scope: 'mpim:write', description: 'Start group direct messages with people.' },
  { scope: 'mpim:write.topic', description: 'Set description/topic in group direct messages.' },
  { scope: 'pins:read', description: 'View pinned content in channels and conversations.' },
  { scope: 'pins:write', description: 'Add and remove pinned messages and files.' },
  { scope: 'reactions:write', description: 'Add and edit emoji reactions.' },
  { scope: 'reminders:read', description: 'View reminders created by the app.' },
  { scope: 'search:read.files', description: 'Search workspace files.' },
  { scope: 'search:read.public', description: 'Search workspace content in public channels.' },
  { scope: 'search:read.users', description: 'Search workspace users.' },
  { scope: 'team:read', description: 'View workspace name, email domain, and icon.' },
  { scope: 'usergroups:read', description: 'View user groups in a workspace.' },
  { scope: 'usergroups:write', description: 'Create and manage user groups.' },
  { scope: 'users.profile:read', description: 'View profile details about users.' },
  { scope: 'users:read', description: 'View people in a workspace.' },
  { scope: 'users:read.email', description: 'View user email addresses.' },
  { scope: 'users:write', description: 'Set presence for the app user.' },
];

function scopeToToolName(scope: string): string {
  return `slack_${ scope.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase() }`;
}

function inferOperationType(name: string): 'read' | 'create' | 'update' | 'delete' | 'execute' {
  const normalized = (name || '').toLowerCase();
  const hasAny = (terms: string[]): boolean => terms.some(term => normalized.includes(term));

  if (hasAny(['delete', 'remove', 'drop', 'purge'])) return 'delete';
  if (hasAny(['create', 'add', 'mkdir', 'new'])) return 'create';
  if (hasAny(['update', 'edit', 'patch', 'modify', 'set_', '_set', 'write', 'append', 'move', 'copy', 'upload', 'activate', 'deactivate', 'post', 'execute', 'run_', '_run', 'open', 'join', 'invite'])) return 'update';
  if (hasAny(['get', 'list', 'read', 'search', 'find', 'check', 'status', 'info', 'history', 'path_info', 'browse'])) return 'read';
  return 'execute';
}

const TOOL_TO_SCOPE = new Map<string, ScopeConfig>(
  SCOPE_CONFIGS.map(scopeConfig => [scopeToToolName(scopeConfig.scope), scopeConfig]),
);

export class SlackScopeCommandWorker extends BaseTool {
  name = '';
  description = '';
  schemaDef: any = {};

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const scopeConfig = TOOL_TO_SCOPE.get(this.name);
    if (!scopeConfig) {
      return {
        successBoolean: false,
        responseString: `Unknown Slack scope command: ${ this.name }`,
      };
    }

    const { apiMethod, params = {} } = input;
    try {
      const slack = await registry.get<SlackClient>('slack');
      if (!slack) {
        return {
          successBoolean: false,
          responseString: `Slack integration is not initialized for scope ${ scopeConfig.scope }`,
        };
      }

      const result = await slack.apiCall(apiMethod, params);
      const success = result?.ok !== false;

      return {
        successBoolean: success,
        responseString: success
          ? `Slack scope command ${ scopeConfig.scope } executed via ${ apiMethod }:\n${ JSON.stringify(result, null, 2) }`
          : `Slack scope command ${ scopeConfig.scope } failed via ${ apiMethod }: ${ result?.error || 'Unknown error' }`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error executing Slack scope command ${ scopeConfig.scope }: ${ (error as Error).message }`,
      };
    }
  }
}

interface ApiCommandConfig {
  name:        string;
  apiMethod:   string;
  description: string;
}

const API_COMMAND_CONFIGS: ApiCommandConfig[] = [
  { name: 'slack_cmd_bookmarks_list', apiMethod: 'bookmarks.list', description: 'List bookmarks in a channel.' },
  { name: 'slack_cmd_bookmarks_add', apiMethod: 'bookmarks.add', description: 'Create a bookmark.' },
  { name: 'slack_cmd_bookmarks_edit', apiMethod: 'bookmarks.edit', description: 'Edit a bookmark.' },
  { name: 'slack_cmd_bookmarks_remove', apiMethod: 'bookmarks.remove', description: 'Remove a bookmark.' },
  { name: 'slack_cmd_calls_list', apiMethod: 'calls.list', description: 'List ongoing and past calls.' },
  { name: 'slack_cmd_canvases_sections_lookup', apiMethod: 'canvases.sections.lookup', description: 'Read canvas sections.' },
  { name: 'slack_cmd_channels_history', apiMethod: 'conversations.history', description: 'Get channel message history.' },
  { name: 'slack_cmd_channels_join', apiMethod: 'conversations.join', description: 'Join a public channel.' },
  { name: 'slack_cmd_channels_read', apiMethod: 'conversations.list', description: 'List channels (set params.types to public_channel/private_channel/im/mpim).' },
  { name: 'slack_cmd_channels_invite', apiMethod: 'conversations.invite', description: 'Invite users to a channel.' },
  { name: 'slack_cmd_chat_post_message', apiMethod: 'chat.postMessage', description: 'Send a new message.' },
  { name: 'slack_cmd_chat_post_customized', apiMethod: 'chat.postMessage', description: 'Send a message with optional custom username/icon params.' },
  { name: 'slack_cmd_chat_unfurl', apiMethod: 'chat.unfurl', description: 'Embed/unfurl URLs in a message.' },
  { name: 'slack_cmd_emoji_list', apiMethod: 'emoji.list', description: 'List custom emoji.' },
  { name: 'slack_cmd_files_list', apiMethod: 'files.list', description: 'List files.' },
  { name: 'slack_cmd_files_upload', apiMethod: 'files.uploadV2', description: 'Upload a file.' },
  { name: 'slack_cmd_files_delete', apiMethod: 'files.delete', description: 'Delete a file.' },
  { name: 'slack_cmd_groups_create', apiMethod: 'conversations.create', description: 'Create a private channel.' },
  { name: 'slack_cmd_groups_set_topic', apiMethod: 'conversations.setTopic', description: 'Set private channel topic.' },
  { name: 'slack_cmd_im_open', apiMethod: 'conversations.open', description: 'Start/open a DM.' },
  { name: 'slack_cmd_im_set_topic', apiMethod: 'conversations.setTopic', description: 'Set DM topic.' },
  { name: 'slack_cmd_incoming_webhook_post', apiMethod: 'chat.postMessage', description: 'Post message to a specific channel.' },
  { name: 'slack_cmd_links_read', apiMethod: 'search.messages', description: 'Search/read links from messages.' },
  { name: 'slack_cmd_lists_items_list', apiMethod: 'lists.items.list', description: 'Read list items.' },
  { name: 'slack_cmd_metadata_message_read', apiMethod: 'conversations.history', description: 'Read message metadata via history retrieval.' },
  { name: 'slack_cmd_mpim_open', apiMethod: 'conversations.open', description: 'Start/open a group DM.' },
  { name: 'slack_cmd_mpim_set_topic', apiMethod: 'conversations.setTopic', description: 'Set group DM topic.' },
  { name: 'slack_cmd_pins_list', apiMethod: 'pins.list', description: 'List pinned items.' },
  { name: 'slack_cmd_pins_add', apiMethod: 'pins.add', description: 'Pin a message or file.' },
  { name: 'slack_cmd_pins_remove', apiMethod: 'pins.remove', description: 'Remove a pin.' },
  { name: 'slack_cmd_reactions_add', apiMethod: 'reactions.add', description: 'Add a reaction.' },
  { name: 'slack_cmd_reactions_remove', apiMethod: 'reactions.remove', description: 'Remove a reaction.' },
  { name: 'slack_cmd_reminders_list', apiMethod: 'reminders.list', description: 'List reminders.' },
  { name: 'slack_cmd_search_files', apiMethod: 'search.files', description: 'Search files.' },
  { name: 'slack_cmd_search_public', apiMethod: 'search.messages', description: 'Search public channel content.' },
  { name: 'slack_cmd_search_users', apiMethod: 'users.list', description: 'Search/list users.' },
  { name: 'slack_cmd_team_info', apiMethod: 'team.info', description: 'Read workspace info.' },
  { name: 'slack_cmd_usergroups_list', apiMethod: 'usergroups.list', description: 'List user groups.' },
  { name: 'slack_cmd_usergroups_create', apiMethod: 'usergroups.create', description: 'Create a user group.' },
  { name: 'slack_cmd_usergroups_update', apiMethod: 'usergroups.update', description: 'Update a user group.' },
  { name: 'slack_cmd_users_profile_get', apiMethod: 'users.profile.get', description: 'Get user profile details.' },
  { name: 'slack_cmd_users_list', apiMethod: 'users.list', description: 'List users.' },
  { name: 'slack_cmd_users_set_presence', apiMethod: 'users.setPresence', description: 'Set app user presence.' },
];

const TOOL_TO_API_COMMAND = new Map<string, ApiCommandConfig>(
  API_COMMAND_CONFIGS.map(command => [command.name, command]),
);

export class SlackApiCommandWorker extends BaseTool {
  name = '';
  description = '';
  schemaDef: any = {};

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const command = TOOL_TO_API_COMMAND.get(this.name);
    if (!command) {
      return {
        successBoolean: false,
        responseString: `Unknown Slack API command: ${ this.name }`,
      };
    }

    const params = input?.params && typeof input.params === 'object' ? input.params : {};

    try {
      const slack = await registry.get<SlackClient>('slack');
      if (!slack) {
        return {
          successBoolean: false,
          responseString: `Slack integration is not initialized for command ${ command.name }`,
        };
      }

      const result = await slack.apiCall(command.apiMethod, params);
      const success = result?.ok !== false;

      return {
        successBoolean: success,
        responseString: success
          ? `Slack command ${ command.name } executed via ${ command.apiMethod }:\n${ JSON.stringify(result, null, 2) }`
          : `Slack command ${ command.name } failed via ${ command.apiMethod }: ${ result?.error || 'Unknown error' }`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error executing Slack command ${ command.name }: ${ (error as Error).message }`,
      };
    }
  }
}

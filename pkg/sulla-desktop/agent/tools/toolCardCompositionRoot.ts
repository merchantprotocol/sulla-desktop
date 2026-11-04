// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
import { ToolArgumentRedactor, ToolCardFormatterRegistry, ToolCardPresenter } from './toolCardFormatterRegistry';
import { AgentsToolCardFormatter } from './toolCardStrategies/AgentsToolCardFormatter';
import { BridgeToolCardFormatter } from './toolCardStrategies/BridgeToolCardFormatter';
import { BrowserToolCardFormatter } from './toolCardStrategies/BrowserToolCardFormatter';
import { CalendarToolCardFormatter } from './toolCardStrategies/CalendarToolCardFormatter';
import { DatabaseToolCardFormatter } from './toolCardStrategies/DatabaseToolCardFormatter';
import { DockerToolCardFormatter } from './toolCardStrategies/DockerToolCardFormatter';
import { ExtensionToolCardFormatter } from './toolCardStrategies/ExtensionToolCardFormatter';
import { GitHubToolCardFormatter } from './toolCardStrategies/GitHubToolCardFormatter';
import { GitToolCardFormatter } from './toolCardStrategies/GitToolCardFormatter';
import { MemoryToolCardFormatter } from './toolCardStrategies/MemoryToolCardFormatter';
import { PlatformToolCardFormatter } from './toolCardStrategies/PlatformToolCardFormatter';
import { PrefixToolCardFormatter } from './toolCardStrategies/PrefixToolCardFormatter';
import { RedisToolCardFormatter } from './toolCardStrategies/RedisToolCardFormatter';
import { ShellFileToolCardFormatter } from './toolCardStrategies/ShellFileToolCardFormatter';
import { SlackToolCardFormatter } from './toolCardStrategies/SlackToolCardFormatter';
import { ToolCardText } from './toolCardStrategies/ToolCardText';
import { WorkflowToolCardFormatter } from './toolCardStrategies/WorkflowToolCardFormatter';
import { WorkspaceToolCardFormatter } from './toolCardStrategies/WorkspaceToolCardFormatter';

export class ToolCardCompositionRoot {
  readonly redactor: ToolArgumentRedactor;
  readonly presenter: ToolCardPresenter;
  constructor() {
    const text = new ToolCardText();
    const strategies = [new ShellFileToolCardFormatter(text), new BrowserToolCardFormatter(text),
      new GitToolCardFormatter(text), new GitHubToolCardFormatter(text), new DockerToolCardFormatter(text),
      new SlackToolCardFormatter(text), new DatabaseToolCardFormatter(text), new RedisToolCardFormatter(text),
      new CalendarToolCardFormatter(text), new WorkflowToolCardFormatter(text), new ExtensionToolCardFormatter(text),
      new AgentsToolCardFormatter(text), new BridgeToolCardFormatter(text), new MemoryToolCardFormatter(text),
      new WorkspaceToolCardFormatter(text), new PlatformToolCardFormatter(text)];
    const prefixes = [['fs_', 'Files'], ['git', 'Git'], ['github_', 'GitHub'], ['docker_', 'Docker'],
      ['kubectl_', 'Kubernetes'], ['pg_', 'Database'], ['redis_', 'Redis'], ['slack_', 'Slack'],
      ['calendar_', 'Calendar']].map(([prefix, label]) => new PrefixToolCardFormatter(prefix, label));
    this.redactor = new ToolArgumentRedactor(new Map([
      ['vault_create_password', ['password']], ['vault_update_password', ['password']], ['vault_set_credential', ['value']],
    ]));
    this.presenter = new ToolCardPresenter(new ToolCardFormatterRegistry(strategies, prefixes, text));
  }
}

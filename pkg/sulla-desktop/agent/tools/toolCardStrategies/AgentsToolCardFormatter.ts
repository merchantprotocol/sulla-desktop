// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { MappedToolCardFormatter } from './MappedToolCardFormatter';
import { ToolCardText } from './ToolCardText';
export class AgentsToolCardFormatter extends MappedToolCardFormatter {
  constructor(text: ToolCardText) {
    super({
  spawn_agent(args) {
    const tasks = Array.isArray(args.tasks) ? args.tasks.length : '?';
    return { label: 'Agents', summary: `Spawning ${ tasks } sub-agent${ tasks === 1 ? '' : 's' }` };
  },
  check_agent_jobs(args) {
    return { label: 'Agents', summary: `Checking job ${ text.truncate(text.string(args.jobId), 20) }` };
  },
  list_agents() {
    return { label: 'Agents', summary: 'Listing available agents' };
  },
  agents_directory(args) {
    return { label: 'Agents', summary: args.slug ? `Agent card: ${ text.truncate(text.string(args.slug), 30) }` : args.query ? `Finding agents for: ${ text.truncate(text.string(args.query), 40) }` : 'Listing agent directory' };
  },
    });
  }
}

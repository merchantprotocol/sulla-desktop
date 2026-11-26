// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { BUILTIN_AGENT_RENAMES } from '../../shared/agentJobNames';

/** Shared built-in awareness defaults for runtime policy and schema backfills. */
export class AgentAwarenessDefaults {
  static readonly WORKER_AGENT_SLUGS = Object.freeze([
    'quick-fixer', 'builder', 'lookup', 'generalist', 'advisor', 'analytics-worker',
  ] as const);

  static readonly DEFAULT_OFF_AGENT_SLUGS = Object.freeze([
    ...AgentAwarenessDefaults.WORKER_AGENT_SLUGS, 'integrator', 'premortem-planner', 'designer',
  ] as const);

  static readonly DEFAULT_ON_AGENT_SLUGS = Object.freeze([
    'project-manager', 'coding-manager', 'director', 'ui-test-manager', 'account-manager', 'conversationalist',
  ] as const);

  static readonly DEFAULT_OFF_AGENT_SLUG_SQL = [...AgentAwarenessDefaults.DEFAULT_OFF_AGENT_SLUGS, ...BUILTIN_AGENT_RENAMES.map(([previous]) => previous)].map(slug => `'${ slug }'`).join(',');
  static readonly DEFAULT_ON_AGENT_SLUG_SQL = AgentAwarenessDefaults.DEFAULT_ON_AGENT_SLUGS.map(slug => `'${ slug }'`).join(',');
}

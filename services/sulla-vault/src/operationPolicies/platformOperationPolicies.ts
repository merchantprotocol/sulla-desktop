// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { BrokerInjection } from '../contracts.js';
import { ENTERPRISE_GATEWAY_INJECTION } from '../gatewayPolicy.js';
import { AuthHeaderInjections, type BrokerOperationPolicy } from './BrokerOperationPolicy.js';

const authHeaders = (fields: string[], names?: string[]): BrokerInjection[] => AuthHeaderInjections.of(fields, names);

/** First-party platform operations (GitHub, Slack, Discord, enterprise gateway, MCP, catalog, owner-declared item HTTP). */
export const PLATFORM_OPERATION_POLICIES: Readonly<Record<string, BrokerOperationPolicy>> = {
  'github.api': {
    integrations: ['github'],
    hosts: ['api.github.com'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    injections: authHeaders(['token'], ['authorization']),
  },
  'github.graphql': {
    integrations: ['github'],
    hosts: ['api.github.com'],
    methods: ['POST'],
    injections: authHeaders(['token'], ['authorization']),
  },
  'github.git': {
    integrations: ['github'],
    hosts: ['github.com'],
    methods: ['GET', 'POST'],
    injections: [{ field: 'token', target: 'header', name: 'authorization', scheme: 'GitHubBasic' }],
    allowStreaming: true,
    binaryRequest: true,
    binaryResponse: true,
    pathPattern: /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/(?:info\/refs|git-upload-pack|git-receive-pack)$/,
  },
  'slack.web-api': {
    integrations: ['slack'],
    hosts: ['slack.com'],
    methods: ['GET', 'POST'],
    injections: [{ field: 'bot_token', target: 'header', name: 'authorization', scheme: 'Bearer' }],
  },
  'discord.rest': {
    integrations: ['discord'],
    hosts: ['discord.com', 'discordapp.com'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    injections: [
      { field: 'bot_token', target: 'header', name: 'authorization', scheme: 'Bot' },
      { field: 'token', target: 'header', name: 'authorization', scheme: 'Bot' },
    ],
  },
  'enterprise.gateway.http': {
    integrations: ['enterprise_gateway'],
    requireItemSites: true,
    methods: ['POST', 'DELETE'],
    injections: [ENTERPRISE_GATEWAY_INJECTION],
    pathPattern: /^\/api\/desktop\/sessions(?:\/[A-Za-z0-9._~-]{1,200})?$/,
  },
  'mcp.http': {
    integrations: ['mcp'],
    requireItemSites: true,
    methods: ['GET', 'POST'],
    allowStreaming: true,
    injections: [
      ...authHeaders(['auth_token', 'bearer_token']),
      { field: 'api_key', target: 'header', name: 'x-api-key', scheme: 'raw' },
    ],
  },
  'catalog.http': {
    requireItemSites: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    injections: [
      ...authHeaders(['auth_token', 'bearer_token', 'api_token']),
      { field: 'api_key', target: 'header', name: 'x-api-key', scheme: 'raw' },
      { field: 'api_key', target: 'header', name: 'api-key', scheme: 'raw' },
    ],
  },
  'item.http': {
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    injections: [],
  },
};

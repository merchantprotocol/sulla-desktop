// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { BrokerOperationPolicy } from './BrokerOperationPolicy.js';

/** OAuth custody operations; destinations are bound separately by OAuthPolicy. */
export const OAUTH_OPERATION_POLICIES: Readonly<Record<string, BrokerOperationPolicy>> = {
  'oauth.exchange': {
    requireItemSites: true,
    methods: ['POST'],
    credentialOptional: true,
    injections: [
      { field: 'client_id', target: 'form', name: 'client_id', scheme: 'raw' },
      { field: 'client_secret', target: 'form', name: 'client_secret', scheme: 'raw' },
      { field: 'client_secret', target: 'header', name: 'authorization', scheme: 'BasicClient' },
    ],
  },
  'oauth.register': {
    integrations: ['robinhood'],
    hosts: ['agent.robinhood.com'],
    methods: ['POST'],
    credentialOptional: true,
    injections: [],
    pathPattern: /^\/oauth\/trading\/register$/,
  },
  'oauth.adopt': {
    requireItemSites: true,
    methods: ['POST'],
    injections: [
      { field: 'id_token', target: 'form', name: 'subject_token', scheme: 'raw' },
      { field: 'access_token', target: 'form', name: 'subject_token', scheme: 'raw' },
      { field: 'client_id', target: 'form', name: 'client_id', scheme: 'raw' },
      { field: 'client_secret', target: 'header', name: 'authorization', scheme: 'BasicClient' },
    ],
  },
  'oauth.refresh': {
    requireItemSites: true,
    methods: ['POST'],
    injections: [
      { field: 'refresh_token', target: 'json', name: 'refresh_token', scheme: 'raw' },
      { field: 'refresh_token', target: 'query', name: 'refresh_token', scheme: 'raw' },
      { field: 'refresh_token', target: 'form', name: 'refresh_token', scheme: 'raw' },
      { field: 'client_id', target: 'json', name: 'client_id', scheme: 'raw' },
      { field: 'client_secret', target: 'json', name: 'client_secret', scheme: 'raw' },
      { field: 'client_id', target: 'query', name: 'client_id', scheme: 'raw' },
      { field: 'client_secret', target: 'query', name: 'client_secret', scheme: 'raw' },
      { field: 'client_id', target: 'form', name: 'client_id', scheme: 'raw' },
      { field: 'client_secret', target: 'form', name: 'client_secret', scheme: 'raw' },
      { field: 'client_secret', target: 'header', name: 'authorization', scheme: 'BasicClient' },
    ],
  },
  'oauth.revoke': {
    requireItemSites: true,
    methods: ['POST'],
    injections: [
      { field: 'access_token', target: 'form', name: 'token', scheme: 'raw' },
      { field: 'refresh_token', target: 'form', name: 'token', scheme: 'raw' },
      { field: 'access_token', target: 'query', name: 'token', scheme: 'raw' },
      { field: 'refresh_token', target: 'query', name: 'token', scheme: 'raw' },
      { field: 'client_secret', target: 'header', name: 'authorization', scheme: 'BasicClient' },
    ],
  },
};

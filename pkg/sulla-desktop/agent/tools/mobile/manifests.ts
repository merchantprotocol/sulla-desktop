// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { ToolManifest } from '../registry';

/**
 * Mobile read-side tools query the Sulla Cloud backend so the desktop
 * agent can check whether signed-in devices are reachable.
 *
 * Requests use the user's Cloud JWT from vault `sulla-cloud/api_token`.
 * Base URL defaults to https://sulla-workers.merchantprotocol.workers.dev, can
 * be overridden via vault `sulla-cloud/mobile_api_url`.
 */
export const mobileToolManifests: ToolManifest[] = [
  {
    name:        'list_devices',
    description: 'List every desktop, mobile and paired app device registered to the account, annotated with online/offline status. A device is "online" when it has hit the worker within the last 2 minutes (heartbeat or an authenticated call). Optionally filter by device type.',
    category:    'mobile',
    schemaDef:   {
      online_only: { type: 'boolean', optional: true, description: 'If true, only return devices seen in the last 2 minutes.' },
      device_type: { type: 'enum',    optional: true, enum: ['desktop', 'mobile', 'app'], description: 'Filter to desktop, mobile or app devices only.' },
    },
    operationTypes: ['read'],
    loader:         () => import('./list_devices'),
  },
];

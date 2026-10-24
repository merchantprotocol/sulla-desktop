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
    description: 'List every desktop and mobile device registered to the account, annotated with online/offline status. A device is "online" when it has hit the worker within the last 2 minutes (heartbeat or any authenticated call). Useful for checking whether the Sulla Mobile app is reachable before routing something to it. Optionally filter with { online_only: true } or { device_type: "mobile" | "desktop" }.',
    category:    'mobile',
    schemaDef:   {
      online_only: { type: 'boolean', optional: true, description: 'If true, only return devices seen in the last 2 minutes.' },
      device_type: { type: 'enum',    optional: true, enum: ['desktop', 'mobile'], description: 'Filter to desktop or mobile devices only.' },
    },
    operationTypes: ['read'],
    loader:         () => import('./list_devices'),
  },
];

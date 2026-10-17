import type { BrokerInjection } from './contracts.js';

export interface CallerOperationPolicy {
  integrations: string[];
  hosts:        string[];
  methods:      string[];
  injections:   BrokerInjection[];
  pathPattern:  RegExp;
}

/**
 * Policies owned by first-party Desktop callers. Keep these separate from the
 * shared operation table so the service owner can merge them without taking
 * ownership of the caller adapters.
 */
export const CALLER_OPERATION_POLICIES: Readonly<Record<string, CallerOperationPolicy>> = {
  'sulla-cloud.api': {
    integrations: ['sulla-cloud'],
    hosts: ['sulla-workers.merchantprotocol.workers.dev'],
    methods: ['GET', 'POST'],
    injections: [{ field: 'api_token', target: 'header', name: 'authorization', scheme: 'Bearer' }],
    pathPattern: /^\/(?:calls(?:\/[A-Za-z0-9._~-]{1,200})?|leads|messages|devices|push\/[A-Za-z0-9._~-]{1,200})$/,
  },
  'provider.transcription': {
    integrations: ['grok'],
    hosts: ['api.x.ai'],
    methods: ['POST'],
    injections: [{ field: 'api_key', target: 'header', name: 'authorization', scheme: 'Bearer' }],
    pathPattern: /^\/v1\/stt$/,
  },
};

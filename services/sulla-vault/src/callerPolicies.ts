import type { BrokerInjection } from './contracts.js';

export interface CallerOperationPolicy {
  integrations: string[];
  hosts:        string[];
  methods:      string[];
  injections:   BrokerInjection[];
  pathPattern:  RegExp;
  /** Allows a base64 request body (bodyEncoding) decoded only by the broker. */
  binaryRequest?: boolean;
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
  'sulla-cloud.shares': {
    integrations: ['sulla-cloud'],
    hosts: ['sulla-workers.merchantprotocol.workers.dev'],
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'PUT'],
    injections: [{ field: 'api_token', target: 'header', name: 'authorization', scheme: 'Bearer' }],
    pathPattern: /^\/shares(?:\/[A-Za-z0-9._~-]{1,200}(?:\/content)?)?$/,
  },
  // Files cloud sync ciphertext API. Only the sulla-files service identity is
  // trusted for it (localAuthority), and only it gets the larger byte limits.
  'sulla-cloud.files-sync': {
    integrations: ['sulla-cloud'],
    hosts: ['sulla-workers.merchantprotocol.workers.dev'],
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    injections: [{ field: 'api_token', target: 'header', name: 'authorization', scheme: 'Bearer' }],
    pathPattern: /^\/files-sync\/v1\/(collections(\/[0-9a-f-]{36}(\/(keys(\/[0-9]+)?|uploads|commit|changes|chunks\/[0-9a-f]{64}))?)?|uploads\/[0-9a-f-]{36}(\/chunks\/[0-9a-f]{64})?|usage)$/,
    binaryRequest: true,
  },
  'sulla-cloud.cloud-files.catalog': {
    integrations: ['sulla-cloud'], hosts: ['sulla-workers.merchantprotocol.workers.dev'], methods: ['PUT'],
    injections: [{ field: 'api_token', target: 'header', name: 'authorization', scheme: 'Bearer' }],
    pathPattern: /^\/cloud-files\/v1\/catalog\/[A-Za-z0-9._~-]{1,200}$/,
  },
  'sulla-cloud.cloud-files.requests': {
    integrations: ['sulla-cloud'], hosts: ['sulla-workers.merchantprotocol.workers.dev'], methods: ['GET'],
    injections: [{ field: 'api_token', target: 'header', name: 'authorization', scheme: 'Bearer' }],
    pathPattern: /^\/cloud-files\/v1\/catalog\/[A-Za-z0-9._~-]{1,200}\/desktop-requests$/,
  },
  'sulla-cloud.cloud-files.content': {
    integrations: ['sulla-cloud'], hosts: ['sulla-workers.merchantprotocol.workers.dev'], methods: ['PUT'],
    injections: [{ field: 'api_token', target: 'header', name: 'authorization', scheme: 'Bearer' }],
    pathPattern: /^\/cloud-files\/v1\/catalog\/[A-Za-z0-9._~-]{1,200}\/desktop-requests\/[A-Za-z0-9._~-]{1,200}\/content$/,
    binaryRequest: true,
  },
  'sulla-cloud.cloud-files.result': {
    integrations: ['sulla-cloud'], hosts: ['sulla-workers.merchantprotocol.workers.dev'], methods: ['POST'],
    injections: [{ field: 'api_token', target: 'header', name: 'authorization', scheme: 'Bearer' }],
    pathPattern: /^\/cloud-files\/v1\/catalog\/[A-Za-z0-9._~-]{1,200}\/desktop-requests\/[A-Za-z0-9._~-]{1,200}\/(?:link|fail)$/,
  },
  'provider.transcription': {
    integrations: ['grok'],
    hosts: ['api.x.ai'],
    methods: ['POST'],
    injections: [{ field: 'api_key', target: 'header', name: 'authorization', scheme: 'Bearer' }],
    pathPattern: /^\/v1\/stt$/,
  },
};

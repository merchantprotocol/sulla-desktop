// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { BrokerInjection } from '../contracts.js';

export interface BrokerOperationPolicy {
  integrations?:   string[];
  hosts?:          string[];
  requireItemSites?: boolean;
  methods:         string[];
  injections:      BrokerInjection[];
  allowStreaming?: boolean;
  binaryRequest?:  boolean;
  binaryResponse?: boolean;
  credentialOptional?: boolean;
  pathPattern?:    RegExp;
  /** Provider-specific authority that must remain coupled as one trust decision. */
  bindings?:       readonly {
    integration: string;
    hosts?:      string[];
    injections:  BrokerInjection[];
    requiredInjections?: BrokerInjection[];
    /** Optional exact one-of sets for integrations with mutually exclusive credential modes. */
    injectionSets?: readonly (readonly BrokerInjection[])[];
    pathPattern?: RegExp;
  }[];
}

/** Builds the header-injection allowlist entries for credential fields across header names and schemes. */
export class AuthHeaderInjections {
  static of(fields: string[], names = ['authorization']): BrokerInjection[] {
    return fields.flatMap(field =>
      names.flatMap(name => ['Bearer', 'raw'].map(scheme => ({ field, target: 'header' as const, name, scheme: scheme as 'Bearer' | 'raw' }))));
  }
}

export const OPENAI_COMPATIBLE_PROVIDER_BINDINGS = [
  { integration: 'openrouter', hosts: ['openrouter.ai'], inference: /^\/api\/v1\/chat\/completions$/, discovery: /^\/api\/v1\/models$/ },
  { integration: 'fireworks', hosts: ['api.fireworks.ai'], inference: /^\/inference\/v1\/chat\/completions$/, discovery: /^\/inference\/v1\/models$/ },
  { integration: 'perplexity', hosts: ['api.perplexity.ai'], inference: /^\/chat\/completions$/, discovery: /^\/models$/ },
  { integration: 'zai', hosts: ['api.z.ai', 'open.bigmodel.cn'], inference: /^\/api\/(?:coding\/)?paas\/v4\/chat\/completions$/, discovery: /^\/api\/(?:coding\/)?paas\/v4\/models$/ },
  { integration: 'minimax', hosts: ['api.minimax.io', 'api.minimaxi.com'], inference: /^\/v1\/chat\/completions$/, discovery: /^\/v1\/models$/ },
  { integration: 'huggingface', hosts: ['router.huggingface.co'], inference: /^\/v1\/chat\/completions$/, discovery: /^\/v1\/models$/ },
  { integration: 'github-models', hosts: ['models.github.ai'], inference: /^\/inference\/chat\/completions$/, discovery: /^\/catalog\/models$/ },
  { integration: 'deepinfra', hosts: ['api.deepinfra.com'], inference: /^\/v1\/openai\/chat\/completions$/, discovery: /^\/v1\/openai\/models$/ },
  { integration: 'sambanova', hosts: ['api.sambanova.ai'], inference: /^\/v1\/chat\/completions$/, discovery: /^\/v1\/models$/ },
  { integration: 'ollama-cloud', hosts: ['ollama.com'], inference: /^\/v1\/chat\/completions$/, discovery: /^\/api\/tags$/ },
  { integration: 'azure-openai', inference: /^\/openai\/v1\/chat\/completions$/, discovery: /^\/openai\/v1\/models$/ },
  { integration: 'aws-bedrock', hosts: ['bedrock-runtime.us-east-1.amazonaws.com', 'bedrock-runtime.us-west-2.amazonaws.com', 'bedrock-runtime.eu-central-1.amazonaws.com', 'bedrock-runtime.eu-west-1.amazonaws.com', 'bedrock-runtime.ap-northeast-1.amazonaws.com', 'bedrock-runtime.ap-southeast-2.amazonaws.com'], inference: /^\/openai\/v1\/chat\/completions$/, discovery: /^\/openai\/v1\/models$/ },
] as const;

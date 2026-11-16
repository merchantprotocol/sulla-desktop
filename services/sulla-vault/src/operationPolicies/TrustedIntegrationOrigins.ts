// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { OPENAI_COMPATIBLE_PROVIDER_BINDINGS } from './BrokerOperationPolicy.js';

export const TRUSTED_INTEGRATION_ORIGINS: Readonly<Record<string, string[]>> = {
  github:    ['api.github.com', 'github.com'],
  slack:     ['slack.com'],
  discord:   ['discord.com', 'discordapp.com'],
  openai:    ['api.openai.com'],
  codex:     ['chatgpt.com'],
  anthropic: ['api.anthropic.com'],
  'claude-code': ['api.anthropic.com'],
  google:    ['generativelanguage.googleapis.com'],
  grok:      ['api.x.ai', 'cli-chat-proxy.grok.com'],
  elevenlabs: ['api.elevenlabs.io'],
  kimi:      ['api.moonshot.ai', 'api.moonshot.cn'],
  nvidia:    ['integrate.api.nvidia.com'],
  alibaba:   ['dashscope-intl.aliyuncs.com', 'dashscope-us.aliyuncs.com', 'dashscope.aliyuncs.com', 'coding-intl.dashscope.aliyuncs.com', 'coding.dashscope.aliyuncs.com'],
  groq:      ['api.groq.com'],
  mistral:   ['api.mistral.ai'],
  cerebras:  ['api.cerebras.ai'],
  together:  ['api.together.xyz'],
  cohere:    ['api.cohere.ai', 'api.cohere.com'],
  deepseek:  ['api.deepseek.com'],
  arcee:     ['api.arcee.ai'],
  ...Object.fromEntries(OPENAI_COMPATIBLE_PROVIDER_BINDINGS.flatMap(provider =>
    'hosts' in provider ? [[provider.integration, [...provider.hosts]]] : [])),
  enterprise_gateway: [],
};

/** Product-trusted destination hosts per integration. */
export class TrustedIntegrationOrigins {
  constructor(private readonly origins: Readonly<Record<string, string[]>> = TRUSTED_INTEGRATION_ORIGINS) {}

  /** A fresh copy of the trusted hosts for `integrationId` (empty when unknown). */
  originsFor(integrationId: string): string[] {
    return [...(this.origins[integrationId] ?? [])];
  }
}

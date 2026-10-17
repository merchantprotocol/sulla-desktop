import { describe, expect, jest, test } from '@jest/globals';

import {
  getProviderExecutionTransport,
  requireBrokeredContainerAuth,
  requireContainerToolConfig,
  withProviderExecutionTransport,
  type ProviderExecutionTransport,
  type ProviderTransportContext,
} from '../ProviderExecutionTransport';

jest.mock('@pkg/utils/paths', () => ({
  __esModule: true,
  default:    { limactl: '/bin/true', lima: '/dev/null', sullaHome: '/tmp' },
}));
jest.mock('electron', () => ({ __esModule: true, default: {} }));

function codexContext(overrides: Partial<ProviderTransportContext> = {}): ProviderTransportContext {
  return {
    runtime:        'container',
    provider:       'codex',
    conversationId: 'synthetic-thread',
    auth:           { kind: 'broker', opaqueConfigRef: 'opaque:test' },
    session:        {
      opaqueProviderConfigRef: 'opaque:test',
      providerConfig:          {
        opaqueConfigRef:      'opaque:test',
        baseUrl:              'http://provider_broker:8080/codex/lease/v1',
        environment:          { SULLA_PROVIDER_BRIDGE_TOKEN: 'synthetic-capability' },
        codexConfigOverrides: ['model_provider="sulla_broker"'],
      },
    },
    ...overrides,
  };
}

describe('ProviderExecutionTransport security boundary', () => {
  test('fails closed unless broker identity, capability environment, and config match', () => {
    expect(() => requireBrokeredContainerAuth(codexContext())).not.toThrow();
    expect(() => requireBrokeredContainerAuth(codexContext({ session: undefined }))).toThrow(/matching opaque provider config/);
    expect(() => requireBrokeredContainerAuth(codexContext({
      session: {
        opaqueProviderConfigRef: 'opaque:test',
        providerConfig:          {
          opaqueConfigRef: 'opaque:test',
          baseUrl:         'http://provider_broker:8080/codex/lease/v1',
          environment:     {
            SULLA_PROVIDER_BRIDGE_TOKEN: 'synthetic-capability',
            HOME:                        '/host-must-not-cross',
          },
          codexConfigOverrides: ['model_provider="sulla_broker"'],
        },
      },
    }))).toThrow(/environment violates/);
  });

  test('keeps opaque tool identity separate from provider-consumable MCP overrides', () => {
    const context = codexContext();
    context.session = {
      ...context.session,
      opaqueToolConfigRef: 'opaque:tools',
      toolConfig:          {
        opaqueConfigRef:      'opaque:tools',
        codexConfigOverrides: ['mcp_servers.sulla-native.url="http://sulla_tools:3000/mcp"'],
        environment:          {
          SULLA_MCP_SESSION_TOKEN: 'synthetic-mcp-capability',
          SULLA_TOOL_SESSION:      'synthetic-mcp-capability',
        },
      },
    };
    expect(requireContainerToolConfig(context)?.codexConfigOverrides).toHaveLength(1);
    context.session.toolConfig = { opaqueConfigRef: 'opaque:tools' };
    expect(() => requireContainerToolConfig(context)).toThrow(/MCP config overrides/);
  });

  test('keeps one lifecycle transport bound across awaited and nested work', async() => {
    const transport = { runtime: 'container' } as ProviderExecutionTransport;

    await withProviderExecutionTransport(transport, async() => {
      expect(getProviderExecutionTransport()).toBe(transport);
      await Promise.resolve();
      expect(getProviderExecutionTransport()).toBe(transport);
      await withProviderExecutionTransport(transport, async() => {
        await Promise.resolve();
        expect(getProviderExecutionTransport()).toBe(transport);
      });
    });
  });
});

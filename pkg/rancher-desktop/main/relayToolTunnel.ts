import jwt from 'jsonwebtoken';

import { requireAgentContainerRuntime, withAgentContainerRuntime } from '@pkg/agent/services/AgentContainerRuntimeRegistry';
import { GraphRegistry } from '@pkg/agent/services/GraphRegistry';
import { toolRegistry } from '@pkg/agent/tools';
import { getChatCompletionsServer } from '@pkg/main/chatCompletionsServer';
import { getDesktopDeviceId } from '@pkg/main/deviceIdentity';
import { getCurrentUserId } from '@pkg/main/sullaCloudAuth';
import type { RelayToolExecutionContext, RelayToolResult } from '@pkg/runtime/relayProtocol';
import { RelayToolTunnel } from '@pkg/runtime/relayTunnelClient';
import Logging from '@pkg/utils/logging';
import { getLocalVaultPrincipalId, usesContainerVaultAuthority } from '@pkg/vault-broker';

const console = Logging.background;
async function executeThroughRegistry(
  ctx: RelayToolExecutionContext,
  _category: string,
  toolName: string,
  args: unknown,
  signal: AbortSignal,
): Promise<RelayToolResult> {
  // Tool instances carry mutable state, approval signals, and verified caller
  // identity. A cached singleton lets concurrent calls overwrite each other.
  const tool = await toolRegistry.createTool(toolName);
  tool.approvalSignal = signal;
  tool.executionContext = ctx;
  const executionTarget = toolRegistry.getExecutionTarget(toolName);
  const registered = ctx.thread_id ? GraphRegistry.get(ctx.thread_id)?.state : undefined;
  const isolatedState = {
    ...(registered ?? {}),
    toolExecutionContext: ctx,
    metadata:             {
      ...(registered?.metadata ?? {}),
      threadId:             ctx.thread_id ?? registered?.metadata?.threadId ?? '',
      conversationId:       ctx.thread_id ?? registered?.metadata?.conversationId ?? '',
      toolExecutionContext: ctx,
      options:              {
        ...(registered?.metadata?.options ?? {}),
        abort: { signal },
      },
    },
  };
  const state = executionTarget === 'agent-local' ? isolatedState : (registered ?? isolatedState);
  const result = executionTarget === 'agent-local'
    ? await withAgentContainerRuntime(requireAgentContainerRuntime(ctx), () => tool.invoke(args, state))
    : await tool.invoke(args, state);

  return result.success
    ? { success: true, result: result.result }
    : {
      success: false,
      error:   {
        code:    'desktop_tool_failed',
        message: result.error ?? (typeof result.result === 'string' ? result.result : 'Desktop tool failed'),
      },
    };
}

let cloudTunnel: RelayToolTunnel | null = null;
let localTunnel: RelayToolTunnel | null = null;

async function getRelayUserId(): Promise<string> {
  return process.env.SULLA_SERVER_USER_ID?.trim() || await getCurrentUserId();
}

/** Starts only for a joined/configured server. With no relay config Desktop is unchanged. */
export function startRelayToolTunnel(): RelayToolTunnel | null {
  const relayUrl = process.env.SULLA_RELAY_URL?.trim() ?? '';
  const deviceToken = process.env.SULLA_RELAY_DEVICE_TOKEN?.trim() ?? '';
  if (!relayUrl || !deviceToken) return null;
  cloudTunnel ??= new RelayToolTunnel({
    relayUrl,
    deviceToken,
    deviceId:      getDesktopDeviceId,
    currentUserId: getRelayUserId,
    execute:       executeThroughRegistry,
    log:           console,
  });
  cloudTunnel.start();
  return cloudTunnel;
}

export function stopRelayToolTunnel(): void {
  cloudTunnel?.stop();
  cloudTunnel = null;
}

/**
 * Connect Desktop out to the relay running beside sulla-tools in Lima. This
 * preserves the real Desktop/controller owner without requiring an inbound
 * container-to-host address or a static host mapping.
 */
export async function startLocalToolTunnel(): Promise<RelayToolTunnel> {
  if (localTunnel) return localTunnel;
  const secret = getChatCompletionsServer().getApiToken();
  if (!secret) throw new Error('Local tool relay cannot start before the Desktop API token is ready');
  const deviceId = await getDesktopDeviceId();
  const userId = usesContainerVaultAuthority()
    ? await getLocalVaultPrincipalId()
    : await getRelayUserId();
  if (!userId) throw new Error('Local tool relay requires an authenticated owner identity');
  localTunnel = new RelayToolTunnel({
    relayUrl: 'http://127.0.0.1:30126',
    // Mint on every connection. A long-lived Desktop process can reconnect
    // after the previous relay credential expires without a restart.
    deviceToken: () => jwt.sign({
      sub: userId,
      device_id: deviceId,
      aud: 'sulla-relay-device',
    }, secret, { algorithm: 'HS256', expiresIn: '15m' }),
    deviceId: () => Promise.resolve(deviceId),
    currentUserId: () => Promise.resolve(userId),
    execute: executeThroughRegistry,
    log: console,
  });
  localTunnel.start();
  return localTunnel;
}

export function stopLocalToolTunnel(): void {
  localTunnel?.stop();
  localTunnel = null;
}

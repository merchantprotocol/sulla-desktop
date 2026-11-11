// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import jwt from 'jsonwebtoken';

import { containerRuntimeForExecution, withAgentContainerRuntime } from '@pkg/agent/services/AgentContainerRuntimeRegistry';
import { GraphRegistry } from '@pkg/agent/services/GraphRegistry';
import { toolRegistry } from '@pkg/agent/tools';
import { getChatCompletionsServer } from '@pkg/main/chatCompletionsServer';
import { getDesktopDeviceId } from '@pkg/main/deviceIdentity';
import { getCurrentUserId } from '@pkg/main/sullaCloudAuth';
import type { RelayToolExecutionContext, RelayToolResult } from '@pkg/runtime/relayProtocol';
import { RelayToolTunnel } from '@pkg/runtime/relayTunnelClient';
import Logging from '@pkg/utils/logging';
import { getLocalVaultPrincipalId, usesContainerVaultAuthority } from '@pkg/vault-broker';
import { loopbackOrigin } from '@pkg/utils/instance';

const console = Logging.background;
async function executeThroughRegistry(
  ctx: RelayToolExecutionContext,
  category: string,
  toolName: string,
  args: unknown,
  signal: AbortSignal,
): Promise<RelayToolResult> {
  // Relay requests carry an explicit category capability. Resolve within that
  // category only so a same-named tool in another category can never execute.
  const resolvedName = toolRegistry.resolveRegisteredName(category, toolName);
  if (!resolvedName) {
    return { success: false, error: { code: 'tool_not_found', message: `Tool ${ category }/${ toolName } not registered` } };
  }
  // Tool instances carry mutable state, approval signals, and verified caller
  // identity. A cached singleton lets concurrent calls overwrite each other.
  const tool = await toolRegistry.createTool(resolvedName);
  tool.approvalSignal = signal;
  tool.executionContext = ctx;
  const executionTarget = toolRegistry.getExecutionTarget(resolvedName);
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
  const containerRuntime = containerRuntimeForExecution(ctx, executionTarget);
  const state = containerRuntime ? isolatedState : (registered ?? isolatedState);
  const result = containerRuntime
    ? await withAgentContainerRuntime(containerRuntime, () => tool.invoke(args, state))
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
    operationTypes: (_category, name) => {
      const registered = toolRegistry.resolveRegisteredName(_category, name);
      return registered ? toolRegistry.getOperationTypes(registered) : [];
    },
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
 * Connect Desktop out to the relay running beside sulla-tools in the Sulla VM. This
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
    relayUrl: loopbackOrigin('http', 30126),
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
    operationTypes: (category, name) => {
      const registered = toolRegistry.resolveRegisteredName(category, name);
      return registered ? toolRegistry.getOperationTypes(registered) : [];
    },
    log: console,
  });
  localTunnel.start();
  return localTunnel;
}

export function stopLocalToolTunnel(): void {
  localTunnel?.stop();
  localTunnel = null;
}

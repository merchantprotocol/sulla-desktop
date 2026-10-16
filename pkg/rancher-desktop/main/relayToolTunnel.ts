import { getTool } from '@pkg/agent/tools';
import { getDesktopDeviceId } from '@pkg/main/deviceIdentity';
import { getCurrentUserId } from '@pkg/main/sullaCloudAuth';
import type { RelayToolExecutionContext, RelayToolResult } from '@pkg/runtime/relayProtocol';
import { RelayToolTunnel } from '@pkg/runtime/relayTunnelClient';
import Logging from '@pkg/utils/logging';

const console = Logging.background;
async function executeThroughRegistry(
  ctx: RelayToolExecutionContext,
  _category: string,
  toolName: string,
  args: unknown,
  signal: AbortSignal,
): Promise<RelayToolResult> {
  const tool = await getTool(toolName);
  tool.approvalSignal = signal;
  const state = {
    toolExecutionContext: ctx,
    metadata:             {
      threadId:             ctx.thread_id ?? '',
      conversationId:       ctx.thread_id ?? '',
      toolExecutionContext: ctx,
      options:              { abort: { signal } },
    },
  };
  const result = await tool.invoke(args, state);

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

let tunnel: RelayToolTunnel | null = null;

async function getRelayUserId(): Promise<string> {
  return process.env.SULLA_SERVER_USER_ID?.trim() || await getCurrentUserId();
}

/** Starts only for a joined/configured server. With no relay config Desktop is unchanged. */
export function startRelayToolTunnel(): RelayToolTunnel | null {
  const relayUrl = process.env.SULLA_RELAY_URL?.trim() ?? '';
  const deviceToken = process.env.SULLA_RELAY_DEVICE_TOKEN?.trim() ?? '';
  if (!relayUrl || !deviceToken) return null;
  tunnel ??= new RelayToolTunnel({
    relayUrl,
    deviceToken,
    deviceId:      getDesktopDeviceId,
    currentUserId: getRelayUserId,
    execute:       executeThroughRegistry,
    log:           console,
  });
  tunnel.start();
  return tunnel;
}

export function stopRelayToolTunnel(): void {
  tunnel?.stop();
  tunnel = null;
}

import { BaseTool, ToolResponse } from '../base';
import { registry } from '../../integrations';
import { slackClient } from '../../integrations/slack/SlackClient';
import type { SlackClient } from '../../integrations/slack/SlackClient';

function runtimeContext() {
  return {
    pid:         typeof process !== 'undefined' ? process.pid : null,
    nodeEnv:     typeof process !== 'undefined' ? process.env.NODE_ENV || null : null,
    processType: typeof process !== 'undefined' ? ((process as any).type || 'node') : 'unknown',
    platform:    typeof process !== 'undefined' ? process.platform : 'unknown',
    hasWindow:   typeof window !== 'undefined',
  };
}

/**
 * Slack Send Message Tool - Worker class for execution
 */
export class SlackSendMessageWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { channel, text } = input;
    const invocationId = `send-${ Date.now() }-${ Math.random().toString(36).slice(2, 8) }`;
    const startedAt = Date.now();

    console.log('[slack_send_message] Invocation start', {
      invocationId,
      runtime:              runtimeContext(),
      channel,
      textLength:           typeof text === 'string' ? text.length : null,
      singletonIsConnected: slackClient.isConnected?.(),
    });

    try {
      console.log('[slack_send_message] Requesting registry.get(slack)...', { invocationId });
      const slack = await registry.get<SlackClient>('slack');
      console.log('[slack_send_message] registry.get result', {
        invocationId,
        gotClient:            !!slack,
        clientType:           slack ? typeof slack : 'null',
        isSlackClient:        slack === (slackClient as unknown),
        singletonIsConnected: slackClient.isConnected?.(),
      });

      if (!slack) {
        console.warn('[slack_send_message] Missing Slack client from registry', {
          invocationId,
          durationMs: Date.now() - startedAt,
          runtime:    runtimeContext(),
        });
        return {
          successBoolean: false,
          responseString: `Slack integration is not initialized for command ${ this.name }`,
        };
      }

      console.log('[slack_send_message] Calling slack.sendMessage', {
        invocationId,
        channel,
        textPreview: typeof text === 'string' ? text.slice(0, 80) : null,
      });
      const res = await slack.sendMessage(channel, text);
      console.log('[slack_send_message] sendMessage response', {
        invocationId,
        ok:         !!res?.ok,
        ts:         res?.ts,
        error:      (res as any)?.error || null,
        durationMs: Date.now() - startedAt,
      });

      if (res.ok) {
        return {
          successBoolean: true,
          responseString: `Slack message sent successfully to channel ${ channel } at timestamp ${ res.ts }`,
        };
      }

      return {
        successBoolean: false,
        responseString: `Failed to send Slack message: ${ res.error || 'Unknown error' }`,
      };
    } catch (error) {
      console.error('[slack_send_message] Invocation failed', {
        invocationId,
        runtime:              runtimeContext(),
        durationMs:           Date.now() - startedAt,
        singletonIsConnected: slackClient.isConnected?.(),
        error,
      });
      return {
        successBoolean: false,
        responseString: `Error sending Slack message: ${ (error as Error).message }`,
      };
    }
  }
}

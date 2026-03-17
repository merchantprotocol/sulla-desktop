import { BaseTool, ToolResponse } from '../base';

const REPLY_WAIT_MS = 5000;

/**
 * send_channel_message — Send a message to any WebSocket channel.
 * Any agent can use this to communicate with any other agent or the human.
 * The sender identifies itself so the receiver knows where to reply.
 *
 * After sending, the tool listens on the sender's channel for up to
 * REPLY_WAIT_MS for a reply. If one arrives, it is returned inline so
 * the LLM sees it immediately. Otherwise a normal "delivered" response
 * is returned and any late reply will arrive as a future user message.
 */
export class SendChannelMessageWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const wsChannel: string = (this.state as any)?.metadata?.wsChannel || 'unknown';
    const channel = input.target_channel || input.channel;
    const message = input.message;
    const sender_id = wsChannel;
    const replyChannel = wsChannel;

    try {
      const { getWebSocketClientService } = await import('../../services/WebSocketClientService');
      const wsService = getWebSocketClientService();

      // Connect to the target channel (no-op if already connected) and send
      wsService.connect(channel);

      const sent = await wsService.send(channel, {
        type: 'user_message',
        data: {
          content:       `[Channel message from ${ sender_id || 'unknown' } on ${ replyChannel || 'unknown' }]\n\n${ message }`,
          kind:          'channel_message',
          senderId:      sender_id || 'unknown',
          senderChannel: replyChannel,
        },
        timestamp: Date.now(),
      });

      if (!sent) {
        return {
          successBoolean: false,
          responseString: `Failed to deliver message to channel "${ channel }". The channel may not have any active subscribers.`,
        };
      }

      // Wait briefly for a reply on the sender's channel
      if (replyChannel) {
        const reply = await this.waitForReply(wsService, replyChannel);
        if (reply) {
          return {
            successBoolean: true,
            responseString: `Message delivered to "${ channel }". Reply received:\n\n${ reply }`,
          };
        }
      }

      return {
        successBoolean: true,
        responseString: `Message delivered to channel "${ channel }" from "${ sender_id }". ` +
          `No reply arrived within ${ REPLY_WAIT_MS / 1000 }s. ` +
          `If the receiver replies later, it will arrive on your channel ("${ replyChannel }") as an incoming message.`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Failed to send message to channel "${ channel }": ${ error instanceof Error ? error.message : String(error) }`,
      };
    }
  }

  /**
   * Subscribe to replyChannel and wait up to REPLY_WAIT_MS for an
   * incoming user_message. Resolves with the content string or null.
   */
  private waitForReply(wsService: any, replyChannel: string): Promise<string | null> {
    return new Promise((resolve) => {
      let unsub: (() => void) | null = null;
      const timer = setTimeout(() => {
        unsub?.();
        resolve(null);
      }, REPLY_WAIT_MS);

      unsub = wsService.onMessage(replyChannel, (msg: any) => {
        if (msg.type !== 'user_message') return;
        const data = typeof msg.data === 'string' ? { content: msg.data } : (msg.data || {});
        const content = (data.content ?? '').trim();
        if (!content) return;
        clearTimeout(timer);
        unsub?.();
        resolve(content);
      });

      // If subscription failed (channel doesn't exist yet), resolve immediately
      if (!unsub) {
        clearTimeout(timer);
        resolve(null);
      }
    });
  }
}

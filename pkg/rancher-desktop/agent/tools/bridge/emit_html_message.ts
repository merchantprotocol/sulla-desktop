import { BaseTool, ToolResponse } from '../base';

const MAX_CONTENT_BYTES = 500 * 1024; // 500 KB

/**
 * emit_html_message — Send rich HTML content to the chat UI.
 *
 * The HTML is rendered inside a Shadow DOM container in the frontend,
 * providing full CSS/JS isolation from the parent chat interface.
 * Supports embedded <style>, <script>, and any standard HTML elements.
 */
export class EmitHtmlMessageWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { content, title } = input;

    if (!content || typeof content !== 'string' || !content.trim()) {
      return {
        successBoolean: false,
        responseString: 'HTML content is required and must be a non-empty string.',
      };
    }

    if (content.length > MAX_CONTENT_BYTES) {
      return {
        successBoolean: false,
        responseString: `HTML content exceeds the ${ MAX_CONTENT_BYTES / 1024 }KB limit (${ Math.round(content.length / 1024) }KB provided). Reduce the content size.`,
      };
    }

    try {
      const sent = await this.emitMessage(content, 'html');
      if (sent) {
        return {
          successBoolean: true,
          responseString: title
            ? `HTML message "${ title }" delivered to chat.`
            : 'HTML message delivered to chat.',
        };
      }

      return {
        successBoolean: false,
        responseString: 'Failed to deliver HTML message — no active chat connection.',
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Failed to emit HTML message: ${ error instanceof Error ? error.message : String(error) }`,
      };
    }
  }
}

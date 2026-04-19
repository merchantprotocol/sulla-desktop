import { calendarClient } from '../../services/CalendarClient';
import { BaseTool, ToolResponse } from '../base';

/**
 * Calendar Delete Tool - Worker class for execution
 */
export class CalendarDeleteWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { eventId } = input;

    try {
      const success = await calendarClient.delete(eventId);
      if (success) {
        return {
          successBoolean: true,
          responseString: `Event with ID ${ eventId } deleted successfully.`,
        };
      } else {
        return {
          successBoolean: false,
          responseString: `Event with ID ${ eventId } not found.`,
        };
      }
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error deleting calendar event: ${ (error as Error).message }`,
      };
    }
  }
}

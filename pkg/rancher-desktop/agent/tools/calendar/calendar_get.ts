import { calendarClient } from '../../services/CalendarClient';
import { BaseTool, ToolResponse } from '../base';

/**
 * Calendar Get Tool - Worker class for execution
 */
export class CalendarGetWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { eventId } = input;

    try {
      const event = await calendarClient.get(eventId);
      if (!event) {
        return {
          successBoolean: false,
          responseString: `Event with ID ${ eventId } not found.`,
        };
      }

      // Format detailed event information
      const startDate = new Date(event.start).toLocaleString();
      const endDate = event.end ? new Date(event.end).toLocaleString() : 'N/A';
      const responseString = `Event Details:
Title: ${ event.title || 'N/A' }
Start: ${ startDate }
End: ${ endDate }
Description: ${ event.description || 'N/A' }
Location: ${ event.location || 'N/A' }
Attendees: ${ event.people ? event.people.join(', ') : 'N/A' }
Status: ${ event.status || 'N/A' }`;

      return {
        successBoolean: true,
        responseString,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error getting calendar event: ${ (error as Error).message }`,
      };
    }
  }
}

import { calendarClient } from '../../services/CalendarClient';
import { BaseTool, ToolResponse } from '../base';

/**
 * Calendar Create Tool - Worker class for execution
 */
export class CalendarCreateWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const event = await calendarClient.create(input);
      if (!event) {
        return {
          successBoolean: false,
          responseString: 'Failed to create calendar event: no event returned.',
        };
      }

      // Format detailed created event information
      const startDate = new Date(event.start).toLocaleString();
      const endDate = event.end ? new Date(event.end).toLocaleString() : 'N/A';
      const responseString = `Event created successfully:
Title: ${ event.title || 'N/A' }
Start: ${ startDate }
End: ${ endDate }
Description: ${ event.description || 'N/A' }
Location: ${ event.location || 'N/A' }
Attendees: ${ event.people ? event.people.join(', ') : 'N/A' }
Status: ${ event.status || 'N/A' }
ID: ${ event.id || 'N/A' }`;

      return {
        successBoolean: true,
        responseString,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error creating calendar event: ${ (error as Error).message }`,
      };
    }
  }
}

import { calendarClient } from '../../services/CalendarClient';
import { BaseTool, ToolResponse } from '../base';

/**
 * Calendar List Tool - Worker class for execution
 */
export class CalendarListWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const events = await calendarClient.getEvents(input);
      if (!events || events.length === 0) {
        return {
          successBoolean: false,
          responseString: 'No calendar events found for the specified criteria.',
        };
      }

      // Format detailed list of events
      let responseString = `Calendar Events (${ events.length } found):\n\n`;
      events.forEach((event: any, index: number) => {
        const startDate = new Date(event.attributes.start).toLocaleString();
        const endDate = event.attributes.end ? new Date(event.attributes.end).toLocaleString() : 'N/A';
        responseString += `${ index + 1 }. Title: ${ event.attributes.title || 'N/A' }\n`;
        responseString += `   Start: ${ startDate }\n`;
        responseString += `   End: ${ endDate }\n`;
        responseString += `   Description: ${ event.attributes.description || 'N/A' }\n`;
        responseString += `   People: ${ event.attributes.people ? event.attributes.people.join(', ') : 'N/A' }\n`;
        responseString += `   Status: ${ event.attributes.status || 'N/A' }\n\n`;
      });

      return {
        successBoolean: true,
        responseString,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error listing calendar events: ${ (error as Error).message }`,
      };
    }
  }
}

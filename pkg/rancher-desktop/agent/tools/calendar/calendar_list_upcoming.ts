import { BaseTool, ToolResponse } from "../base";
import { calendarClient, CalendarEventData } from "../../services/CalendarClient";

/**
 * Calendar List Upcoming Tool - Worker class for execution
 */
export class CalendarListUpcomingWorker extends BaseTool {
  name: string = '';
  description: string = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { days = 7 } = input;

    try {
      const now = new Date();
      const startAfter = now.toISOString();
      const endBefore = new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();

      const events = await calendarClient.getEvents({ startAfter, endBefore });
      if (!events || events.length === 0) {
        return {
          successBoolean: false,
          responseString: `No upcoming calendar events found in the next ${days} days.`
        };
      }

      // Format detailed list of upcoming events
      // Fix #51: Access CalendarEventData properties directly (not via .attributes)
      let responseString = `Upcoming Calendar Events (next ${days} days, ${events.length} found):\n\n`;
      events.forEach((event: CalendarEventData, index: number) => {
        const startDate = new Date(event.start).toLocaleString();
        const endDate = event.end ? new Date(event.end).toLocaleString() : 'N/A';
        responseString += `${index + 1}. Title: ${event.title || 'N/A'}\n`;
        responseString += `   Start: ${startDate}\n`;
        responseString += `   End: ${endDate}\n`;
        responseString += `   Description: ${event.description || 'N/A'}\n`;
        responseString += `   People: ${event.people ? event.people.join(', ') : 'N/A'}\n`;
        responseString += `   Status: ${event.status || 'N/A'}\n\n`;
      });

      return {
        successBoolean: true,
        responseString
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error listing upcoming calendar events: ${(error as Error).message}`
      };
    }
  }
}

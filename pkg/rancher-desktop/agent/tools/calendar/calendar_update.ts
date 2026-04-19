import { calendarClient } from '../../services/CalendarClient';
import { BaseTool, ToolResponse } from '../base';

/**
 * Calendar Update Tool - Worker class for execution
 */
export class CalendarUpdateWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { eventId, ...updates } = input;

    try {
      const updated = await calendarClient.update(eventId, updates);
      if (!updated) {
        return {
          successBoolean: false,
          responseString: `Event with ID ${ eventId } not found.`,
        };
      }

      // Format detailed updated event information
      const startDate = new Date(updated.start).toLocaleString();
      const endDate = updated.end ? new Date(updated.end).toLocaleString() : 'N/A';
      const responseString = `Event updated successfully:
Title: ${ updated.title || 'N/A' }
Start: ${ startDate }
End: ${ endDate }
Description: ${ updated.description || 'N/A' }
Location: ${ updated.location || 'N/A' }
Attendees: ${ updated.people ? updated.people.join(', ') : 'N/A' }
Status: ${ updated.status || 'N/A' }
ID: ${ updated.id || 'N/A' }`;

      return {
        successBoolean: true,
        responseString,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error updating calendar event: ${ (error as Error).message }`,
      };
    }
  }
}

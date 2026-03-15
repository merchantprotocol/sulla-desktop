import type { ToolManifest } from '../registry';

export const calendarToolManifests: ToolManifest[] = [
  {
    name:        'calendar_cancel',
    description: 'Cancel a calendar event by ID.',
    category:    'calendar',
    schemaDef:   {
      eventId: { type: 'number', description: 'The ID of the calendar event to cancel' },
    },
    operationTypes: ['delete'],
    loader:         () => import('./calendar_cancel'),
  },
  {
    name:        'calendar_create',
    description: 'Create a new calendar event or reminder.',
    category:    'calendar',
    schemaDef:   {
      title:       { type: 'string', description: 'Event title' },
      start:       { type: 'string', description: 'Start time in ISO format' },
      end:         { type: 'string', description: 'End time in ISO format' },
      description: { type: 'string', optional: true, description: 'Event description' },
      location:    { type: 'string', optional: true, description: 'Event location' },
      people:      { type: 'array', items: { type: 'string' }, optional: true, description: 'List of attendee emails' },
      calendarId:  { type: 'string', optional: true, description: 'Calendar ID' },
      allDay:      { type: 'boolean', optional: true, description: 'Whether this is an all-day event' },
    },
    operationTypes: ['create'],
    loader:         () => import('./calendar_create'),
  },
  {
    name:        'calendar_delete',
    description: 'Delete a calendar event by ID.',
    category:    'calendar',
    schemaDef:   {
      eventId: { type: 'number', description: 'The ID of the calendar event to delete' },
    },
    operationTypes: ['delete'],
    loader:         () => import('./calendar_delete'),
  },
  {
    name:        'calendar_get',
    description: 'Get details of a specific calendar event by ID.',
    category:    'calendar',
    schemaDef:   {
      eventId: { type: 'number', description: 'The ID of the calendar event' },
    },
    operationTypes: ['read'],
    loader:         () => import('./calendar_get'),
  },
  {
    name:        'calendar_list',
    description: 'List calendar events within a date range.',
    category:    'calendar',
    schemaDef:   {
      startAfter: { type: 'string', optional: true, description: 'Start date filter in ISO format' },
      endBefore:  { type: 'string', optional: true, description: 'End date filter in ISO format' },
      calendarId: { type: 'string', optional: true, description: 'Calendar ID filter' },
    },
    operationTypes: ['read'],
    loader:         () => import('./calendar_list'),
  },
  {
    name:        'calendar_list_upcoming',
    description: 'List upcoming calendar events for the next specified number of days.',
    category:    'calendar',
    schemaDef:   {
      days: { type: 'number', default: 7, description: 'Number of days from now to list upcoming events' },
    },
    operationTypes: ['read'],
    loader:         () => import('./calendar_list_upcoming'),
  },
  {
    name:        'calendar_update',
    description: 'Update an existing calendar event.',
    category:    'calendar',
    schemaDef:   {
      eventId:     { type: 'number', description: 'The ID of the calendar event to update' },
      title:       { type: 'string', optional: true, description: 'New event title' },
      start:       { type: 'string', optional: true, description: 'New start time in ISO format' },
      end:         { type: 'string', optional: true, description: 'New end time in ISO format' },
      description: { type: 'string', optional: true, description: 'New event description' },
      location:    { type: 'string', optional: true, description: 'New event location' },
      people:      { type: 'array', items: { type: 'string' }, optional: true, description: 'New list of attendee emails' },
      calendarId:  { type: 'string', optional: true, description: 'New calendar ID' },
      allDay:      { type: 'boolean', optional: true, description: 'New all-day flag' },
    },
    operationTypes: ['update'],
    loader:         () => import('./calendar_update'),
  },
];

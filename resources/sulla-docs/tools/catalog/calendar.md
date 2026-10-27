# calendar tools

Tools for managing calendar events.

## cancel

Cancel a calendar event by ID.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `eventId` | number | Required |

**Example**

```bash
sulla calendar/cancel '{"eventId":"<eventId>"}'
```

## create

Create a new calendar event or reminder.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `title` | string | Required |
| `start` | string | Required |
| `end` | string | Required |
| `description` | string | Optional |
| `location` | string | Optional |
| `people` | array | Optional |
| `calendarId` | string | Optional |
| `allDay` | boolean | Optional |

**Example**

```bash
sulla calendar/create '{"title":"<title>","start":"<start>","end":"<end>"}'
```

## delete

Delete a calendar event by ID.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `eventId` | number | Required |

**Example**

```bash
sulla calendar/delete '{"eventId":"<eventId>"}'
```

## get

Get details of a specific calendar event by ID.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `eventId` | number | Required |

**Example**

```bash
sulla calendar/get '{"eventId":"<eventId>"}'
```

## list

List calendar events within a date range.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `startAfter` | string | Optional |
| `endBefore` | string | Optional |
| `calendarId` | string | Optional |

**Example**

```bash
sulla calendar/list '{}'
```

## list_upcoming

List upcoming calendar events for the next specified number of days.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `days` | number | Required |

**Example**

```bash
sulla calendar/list_upcoming '{"days":"<days>"}'
```

## update

Update an existing calendar event.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `eventId` | number | Required |
| `title` | string | Optional |
| `start` | string | Optional |
| `end` | string | Optional |
| `description` | string | Optional |
| `location` | string | Optional |
| `people` | array | Optional |
| `calendarId` | string | Optional |
| `allDay` | boolean | Optional |

**Example**

```bash
sulla calendar/update '{"eventId":"<eventId>"}'
```

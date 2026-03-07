# Integration YAML Configuration

## Overview

Sulla uses YAML files to define third-party API integrations. Each integration consists of an **auth config** file (credentials, base URL) and one or more **endpoint config** files (API operations). These YAML definitions are loaded at startup and used by `ConfigApiClient` to make authenticated API calls.

**Integrations repository:** [https://github.com/sulla-ai/integrations](https://github.com/sulla-ai/integrations)

**Local path:** `~/sulla/integrations/`

## Directory Structure

```
~/sulla/integrations/
  youtube/
    youtube.v3-auth.yaml       ← Auth config (base URL, credentials)
    search.v3.yaml             ← Endpoint: search
    videos.v3.yaml             ← Endpoint: list videos
    channels.v3.yaml           ← Endpoint: list channels
  postmark/
    postmark.v1-auth.yaml
    email-send.v1.yaml
    emails-list.v1.yaml
  attio/
    attio.v2-auth.yaml
    records-list.v2.yaml
    records-create.v2.yaml
  ...
```

**File naming conventions:**
- Auth files: `{name}.v{version}-auth.yaml`
- Endpoint files: `{endpoint-name}.v{version}.yaml`

Currently 146 integrations are available in the repository.

## Auth Config Format

The auth file defines the API base URL and authentication method.

### API Key Auth

```yaml
api:
  name: postmark-v1
  version: v1
  provider: postmark
  base_url: https://api.postmarkapp.com

auth:
  type: apiKey
  client_secret: "${POSTMARK_SERVER_TOKEN}"
  header: X-Postmark-Server-Token
  token_storage: local
  refresh_automatically: false
```

### Bearer Token Auth

```yaml
api:
  name: attio-v2
  version: v2
  provider: attio
  base_url: https://api.attio.com/v2

auth:
  type: bearer
  client_secret: "${ATTIO_ACCESS_TOKEN}"
  token_storage: local
  refresh_automatically: false
```

### OAuth2 Auth

```yaml
api:
  name: youtube-data-v3
  version: v3
  provider: google
  base_url: https://www.googleapis.com

auth:
  type: oauth2
  flow: authorization_code
  client_id: "${GOOGLE_CLIENT_ID}"
  client_secret: "${GOOGLE_CLIENT_SECRET}"
  authorization_url: https://accounts.google.com/o/oauth2/v2/auth
  token_url: https://oauth2.googleapis.com/token
  pkce: true
  scopes:
    - https://www.googleapis.com/auth/youtube.readonly
  refresh_automatically: true
  token_expiry_buffer_seconds: 300
```

### API Key Fallback

Some integrations support both OAuth and API key authentication:

```yaml
api_key_fallback:
  enabled: true
  param_name: key
  value: "${YOUTUBE_API_KEY}"
```

### Auth Config Reference

| Field | Type | Description |
|-------|------|-------------|
| `api.name` | `string` | API identifier |
| `api.version` | `string` | API version |
| `api.provider` | `string` | Provider name |
| `api.base_url` | `string` | Base URL for all endpoints |
| `auth.type` | `'oauth2' \| 'apiKey' \| 'bearer'` | Authentication method |
| `auth.client_id` | `string` | OAuth client ID |
| `auth.client_secret` | `string` | OAuth client secret, API key, or bearer token |
| `auth.header` | `string` | Header name for apiKey type (e.g., `X-API-Key`) |
| `auth.authorization_url` | `string` | OAuth authorization endpoint |
| `auth.token_url` | `string` | OAuth token endpoint |
| `auth.pkce` | `boolean` | Enable PKCE for OAuth |
| `auth.scopes` | `string[]` | OAuth scopes |
| `auth.refresh_automatically` | `boolean` | Auto-refresh expired OAuth tokens |
| `auth.token_storage` | `string` | Token storage method |
| `api_key_fallback.enabled` | `boolean` | Enable API key fallback |
| `api_key_fallback.param_name` | `string` | Query parameter name for API key |
| `api_key_fallback.value` | `string` | API key value or `${ENV_VAR}` |

### Environment Variable References

Use `${ENV_VAR}` syntax in YAML to reference environment variables. These are resolved at runtime:

```yaml
auth:
  client_secret: "${MY_API_KEY}"
```

In practice, credentials are usually stored in the IntegrationService database (via the UI) rather than environment variables. The `${ENV_VAR}` syntax is the fallback when no DB credentials are found.

## Endpoint Config Format

Each endpoint file defines one API operation.

### GET Endpoint (Query Parameters)

```yaml
endpoint:
  name: subscribers-list
  description: List all subscribers in your Drip account
  path: /subscribers
  method: GET
  auth: required
  quota_cost: 1

query_params:
  page:
    type: integer
    required: false
    default: 1
    description: Page number for pagination
  per_page:
    type: integer
    required: false
    default: 100
    max: 1000
    description: Number of subscribers per page
  status:
    type: string
    required: false
    description: "Filter by status: active, unsubscribed, removed"
    enum:
      - active
      - unsubscribed
      - removed

response:
  items_path: subscribers

examples:
  active_subscribers:
    params:
      per_page: 100
      status: "active"
```

### POST Endpoint (Body Parameters)

```yaml
endpoint:
  name: email-send
  description: Send a single transactional email
  path: /email
  method: POST
  auth: required
  quota_cost: 1

body_params:
  From:
    type: string
    required: true
    description: "Sender email address"
  To:
    type: string
    required: true
    description: "Recipient email address(es)"
  Subject:
    type: string
    required: true
    description: Email subject line
  HtmlBody:
    type: string
    required: false
    description: HTML body of the email
  TextBody:
    type: string
    required: false
  Tag:
    type: string
    required: false
    description: Tag for categorizing the email

response:
  notes: |
    Returns on success:
    - MessageID: Unique ID for tracking
    - SubmittedAt: Timestamp
    - ErrorCode: 0 on success

examples:
  send_html_email:
    body:
      From: "Team <hello@yourdomain.com>"
      To: "jane@example.com"
      Subject: "Welcome aboard"
      HtmlBody: "<h1>Welcome!</h1>"
```

### Path Parameters

```yaml
endpoint:
  name: records-list
  description: Query records of a specific object type
  path: /objects/{object}/records/query
  method: POST
  auth: required

path_params:
  object:
    type: string
    required: true
    description: "Object slug or ID (e.g., people, companies, deals)"

response:
  items_path: data

examples:
  list_people:
    params:
      object: "people"
```

### Pagination Config

```yaml
pagination:
  type: nextPageToken
  next_token_path: nextPageToken
  items_path: items
```

Supported pagination types:
- `nextPageToken` — Token-based pagination (Google APIs, etc.)
- `offsetLimit` — Offset/limit pagination
- `linkHeader` — HTTP Link header pagination

### Endpoint Config Reference

| Field | Type | Description |
|-------|------|-------------|
| `endpoint.name` | `string` | Unique endpoint identifier |
| `endpoint.description` | `string` | Human-readable description |
| `endpoint.path` | `string` | URL path (supports `{param}` interpolation) |
| `endpoint.method` | `'GET' \| 'POST' \| 'PUT' \| 'DELETE' \| 'PATCH'` | HTTP method |
| `endpoint.auth` | `'required' \| 'optional' \| 'none'` | Authentication requirement |
| `endpoint.quota_cost` | `number` | API quota units consumed per call |
| `query_params.{name}.type` | `string` | Parameter type |
| `query_params.{name}.required` | `boolean` | Is the parameter required? |
| `query_params.{name}.default` | `any` | Default value |
| `query_params.{name}.description` | `string` | Parameter description |
| `query_params.{name}.enum` | `string[]` | Allowed values |
| `query_params.{name}.min` | `number` | Minimum value |
| `query_params.{name}.max` | `number` | Maximum value |
| `path_params.{name}.type` | `string` | Parameter type |
| `path_params.{name}.required` | `boolean` | Is the parameter required? |
| `path_params.{name}.description` | `string` | Parameter description |
| `pagination.type` | `string` | Pagination strategy |
| `pagination.items_path` | `string` | JSON path to items array in response |
| `pagination.next_token_path` | `string` | JSON path to next page token |
| `response.items_path` | `string` | JSON path to extract items from response |
| `response.notes` | `string` | Documentation notes about the response format |
| `examples.{name}.params` | `object` | Example query/path parameters |
| `examples.{name}.body` | `object` | Example request body |

## Creating a New Integration

### 1. Create the directory

```bash
mkdir ~/sulla/integrations/myservice
```

### 2. Create the auth file

`myservice/myservice.v1-auth.yaml`:

```yaml
api:
  name: myservice-v1
  version: v1
  provider: myservice
  base_url: https://api.myservice.com/v1

auth:
  type: apiKey
  client_secret: "${MYSERVICE_API_KEY}"
  header: Authorization
  token_storage: local
  refresh_automatically: false
```

### 3. Create endpoint files

`myservice/list-items.v1.yaml`:

```yaml
endpoint:
  name: list-items
  description: List all items in your account
  path: /items
  method: GET
  auth: required

query_params:
  page:
    type: integer
    required: false
    default: 1
  limit:
    type: integer
    required: false
    default: 25
    max: 100

response:
  items_path: data

pagination:
  type: offsetLimit
  offset_key: page
  limit_key: limit
  items_path: data
```

### 4. Reload integrations

Integrations are loaded at startup. To reload without restarting, use the IPC command `configapi-reload` from the Electron renderer, or restart the application.

### 5. Store credentials

Use the Sulla UI (Integrations page) to add credentials for your integration, or store them as environment variables matching the `${ENV_VAR}` references in the auth file.

## Credential Resolution Order

When an API call is made, credentials are resolved in this order:

1. **Explicit overrides** — `token` or `apiKey` passed directly in call options
2. **IntegrationService DB** — Credentials stored in PostgreSQL via the UI, looked up by `(slug, property, accountId)`
3. **YAML `${ENV_VAR}` references** — Environment variable fallback
4. **Empty string** — If nothing is found, the credential is empty (likely causing an auth error from the upstream API)

## How It All Connects

```
YAML files in ~/sulla/integrations/
    ↓ loaded by IntegrationConfigLoader on startup
    ↓
ConfigApiClient (one per integration)
    ↓ resolves credentials from IntegrationService DB or env vars
    ↓
REST API: POST /v1/integrations/:accountId/:slug/:endpoint/call
    ↓ model calls this from Python/code
    ↓
Third-party API (YouTube, GitHub, Postmark, etc.)
```

See [Integrations API](../api/integrations.md) for the HTTP endpoint documentation.

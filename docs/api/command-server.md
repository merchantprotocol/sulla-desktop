# HTTP Command Server API

The HTTP Command Server runs on **port 6107** (`127.0.0.1` only) and provides a REST API for controlling the Sulla desktop application. All endpoints require HTTP Basic Authentication using credentials stored in `~/Library/Application Support/rancher-desktop/rd-engine.json`.

## Authentication

Every request must include an `Authorization: Basic <credentials>` header. Two user types exist:

- **`user`** -- external/CLI client (non-interactive).
- **`interactive-user`** -- used by the GUI itself.

Unauthenticated requests receive `401 Unauthorized`.

## CORS

All responses include permissive CORS headers. `OPTIONS` requests return `204 No Content`.

---

## Endpoint Listing

### GET /

Returns a JSON array of all available endpoints across all API versions.

**Response:** `200` -- `application/json`
```json
["GET /v0/settings", "GET /v1/about", "PUT /v1/settings", ...]
```

### GET /v0, GET /v1

Returns a JSON array of endpoints available at the specified API version.

---

## About

### GET /v1/about

Returns a plain-text message describing the API version and its experimental status.

**Response:** `200` -- `text/plain`
```
The API is currently at version 1, but is still considered internal and experimental, and is subject to change without any advance notice.
```

---

## Settings

### GET /v1/settings

Returns the current application settings as a JSON string.

**Response:**
- `200` -- Settings JSON (as `text/plain`).
- `404` -- `"No settings found"` if settings are unavailable.

### GET /v1/settings/locked

Returns the set of locked (admin-enforced) settings.

**Response:**
- `200` -- Locked settings JSON (as `text/plain`).
- `404` -- `"No locked settings found"`.

### PUT /v1/settings

Updates application settings. The request body must be a JSON object representing a partial `Settings` structure. Only the fields provided will be changed.

**Request body:** `application/json` -- partial Settings object (max 4 MiB).
```json
{
  "containerEngine": {
    "name": "moby"
  }
}
```

**Response:**
- `202` -- Settings accepted and being applied.
- `400` -- Validation error (text/plain error message).
- `500` -- Internal error.

### PUT /v1/propose_settings

Validates proposed settings changes without applying them. Useful for checking whether a settings change would be accepted.

**Request body:** `application/json` -- partial Settings object (max 4 MiB).

**Response:**
- `200` -- `application/json` with the validation result.
- `400` -- Validation error.
- `500` -- Internal error.

---

## Transient Settings

### GET /v1/transient_settings

Returns transient (non-persisted) settings as JSON.

**Response:** `200` -- `application/json`

### PUT /v1/transient_settings

Updates transient settings. Request body is a partial `TransientSettings` JSON object.

**Request body:** `application/json` -- partial TransientSettings object (max 4 MiB).

**Response:**
- `202` -- Accepted.
- `400` -- Validation error.
- `500` -- Internal error.

---

## Backend State

### GET /v1/backend_state

Returns the current backend/VM state.

**Response:** `200` -- `application/json`
```json
{
  "vmState": "STARTED",
  "locked": false
}
```

### PUT /v1/backend_state

Sets the desired backend state (e.g. start or stop the VM).

**Request body:** `application/json`
```json
{
  "vmState": "STARTED",
  "locked": false
}
```

**Response:**
- `202` -- State change accepted.
- `500` -- Internal error.

---

## Factory Reset and K8s Reset

### PUT /v1/factory_reset

Performs a full factory reset, restoring the application to its initial state. The server shuts down after accepting the request.

**Request body:** `application/json` (optional)
```json
{
  "keepSystemImages": true
}
```

- `keepSystemImages` (boolean, default `false`) -- If `true`, system container images are preserved.

**Response:**
- `202` -- `"Doing a full factory reset...."` -- reset has been initiated.
- `400` -- Error parsing request body.

### PUT /v1/k8s_reset

Resets the Kubernetes cluster.

**Request body:** `application/json` (optional)
```json
{
  "mode": "fast"
}
```

- `mode` (`"fast"` | `"wipe"`, default `"fast"`) -- `"fast"` resets the cluster; `"wipe"` removes all cluster data.

**Response:**
- `200` -- `"Rancher Desktop <mode> reset successful"`.
- `400` -- Error parsing request body.

---

## Shutdown

### PUT /v1/shutdown

Initiates a graceful shutdown of the application. The server closes immediately after responding.

**Response:** `202` -- `"Shutting down."`

---

## Diagnostics

### GET /v1/diagnostic_categories

Returns a JSON array of diagnostic category names.

**Response:**
- `200` -- `application/json` array of strings.
- `404` -- `"No diagnostic categories found"`.

### GET /v1/diagnostic_ids

Returns diagnostic check IDs for a given category.

**Query parameters:**
- `category` (string, required) -- The category to list IDs for.

**Response:**
- `200` -- `application/json` array of strings.
- `400` -- Missing `category` parameter.
- `404` -- No checks found for the given category.

### GET /v1/diagnostic_checks

Returns diagnostic check results, optionally filtered by category and/or ID.

**Query parameters:**
- `category` (string, optional) -- Filter by category.
- `id` (string, optional) -- Filter by specific check ID.

**Response:** `200` -- `application/json` -- `DiagnosticsResultCollection` object.

### POST /v1/diagnostic_checks

Runs all diagnostic checks and returns the results.

**Response:** `200` -- `application/json` -- `DiagnosticsResultCollection` object.

---

## Extensions

### GET /v1/extensions

Lists all installed extensions with their metadata, version, labels, and status.

**Response:**
- `200` -- `application/json`
```json
{
  "extension-id": {
    "version": "1.0.0",
    "metadata": { ... },
    "labels": { ... },
    "extraUrls": [{ "label": "Docs", "url": "https://..." }],
    "status": "running"
  }
}
```
- `503` -- `"Extension manager is not ready yet."`

### GET /v1/extensions/status

Returns the running status of a specific extension.

**Query parameters:**
- `id` (string, required) -- The extension identifier.

**Response:** `200` -- `application/json`
```json
{
  "id": "extension-id",
  "status": "running"
}
```

Status values: `"running"`, `"stopped"`, or `"not_installed"`.

### POST /v1/extensions/install

Installs an extension by its ID.

**Query parameters:**
- `id` (string, required) -- The extension identifier (e.g. an image reference).

**Response:**
- Success status code with optional JSON or text body.
- `400` -- Missing or invalid `id` parameter.

### POST /v1/extensions/uninstall

Uninstalls an extension by its ID.

**Query parameters:**
- `id` (string, required) -- The extension identifier.
- `deleteData` (string, optional) -- Set to `"true"` to also delete extension data.

**Response:**
- Success status code with `"Deleted <id>"` or response data.
- `400` -- Missing or invalid `id` parameter.

### POST /v1/extensions/start

Starts an installed extension.

**Query parameters:**
- `id` (string, required) -- The extension identifier.

**Response:**
- `200` -- `"Started <id>"`.
- `400` -- Missing or invalid `id`.
- `500` -- Error starting the extension.

### POST /v1/extensions/stop

Stops a running extension.

**Query parameters:**
- `id` (string, required) -- The extension identifier.

**Response:**
- `200` -- `"Stopped <id>"`.
- `400` -- Missing or invalid `id`.
- `500` -- Error stopping the extension.

---

## Snapshots

### GET /v1/snapshots

Lists all available snapshots.

**Response:** `200` -- `application/json` -- array of `Snapshot` objects.

### POST /v1/snapshots

Creates a new snapshot.

**Request body:** `application/json`
```json
{
  "name": "my-snapshot"
}
```

- `name` (string, required) -- The snapshot name.

**Response:**
- `200` -- `"Snapshot successfully created"`.
- `400` -- Missing name or snapshot error.

### POST /v1/snapshot/restore

Restores a snapshot by name.

**Query parameters:**
- `name` (string, required) -- The snapshot name.

**Response:**
- `200` -- `"Snapshot successfully restored"`.
- `400` -- Missing name or snapshot error.

### POST /v1/snapshots/cancel

Cancels an in-progress snapshot operation.

**Response:**
- `200` -- `"Snapshot operation canceled"`.
- `400` -- Snapshot error.

### DELETE /v1/snapshots

Deletes a snapshot by name.

**Query parameters:**
- `name` (string, required) -- The snapshot name.

**Response:**
- `200` -- `"Snapshot successfully deleted"`.
- `400` -- Missing name or snapshot error.

---

## Port Forwarding

### POST /v1/port_forwarding

Creates a port forwarding rule from a host port to a Kubernetes service port.

**Request body:** `application/json`
```json
{
  "namespace": "default",
  "service": "my-service",
  "k8sPort": 8080,
  "hostPort": 9090
}
```

All four fields are required. `k8sPort` can be a number or a named port string.

**Response:**
- `200` -- The assigned host port number (as text).
- `400` -- Missing parameters or forwarding error.

### DELETE /v1/port_forwarding

Removes a port forwarding rule.

**Query parameters:**
- `namespace` (string, required)
- `service` (string, required)
- `k8sPort` (string, required) -- The Kubernetes port (number or named port).

**Response:**
- `200` -- `"Port forwarding successfully deleted"`.
- `400` -- Missing parameters or error.

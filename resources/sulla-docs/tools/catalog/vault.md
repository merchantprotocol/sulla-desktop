# vault tools

Credential vault — list saved credentials, check integration connection status, read secrets, and autofill login forms.

## autofill

Autofill a login form on the active browser tab, or an explicitly requested background tab, with saved vault credentials. Success is returned only after the target tab proves the expected fields are non-empty.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `origin` | string | Optional |
| `account_id` | string | Optional |
| `assetId` | string | Optional |

**Example**

```bash
sulla vault/autofill '{}'
```

## delete_credential

Delete a single credential property from the vault. Destructive — refuses without {"confirm":true}.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `account_type` | string | Required |
| `property` | string | Required |
| `account_id` | string | Optional |
| `confirm` | boolean | Required |

**Example**

```bash
sulla vault/delete_credential '{"account_type":"<account_type>","property":"<property>","confirm":"<confirm>"}'
```

## is_enabled

Check whether a specific integration is enabled (connected). Returns the enabled status along with connection timestamps.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `account_type` | string | Required |

**Example**

```bash
sulla vault/is_enabled '{"account_type":"<account_type>"}'
```

## list

List all saved website credentials in the vault. Shows website URLs and usernames for accounts where AI access is permitted.

**Parameters**

None.

**Example**

```bash
sulla vault/list '{}'
```

## list_accounts

List all accounts configured for an integration. Shows account labels, connection status, and which account is currently active.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `account_type` | string | Required |

**Example**

```bash
sulla vault/list_accounts '{"account_type":"<account_type>"}'
```

## list_api_keys

List vault API key and Login items opened to this agent for outbound API requests. Returns id, name, type, allowed hosts and rule metadata only; never secret values or sources.

**Parameters**

None.

**Example**

```bash
sulla vault/list_api_keys '{}'
```

## read_secrets

Retrieve the credentials and connection status for a specific integration. Shows all accounts if multiple exist, with the active account highlighted.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `account_type` | string | Required |
| `account_id` | string | Optional |
| `include_secrets` | boolean | Optional |

**Example**

```bash
sulla vault/read_secrets '{"account_type":"<account_type>"}'
```

## request

Call an HTTPS API using an owner-configured vault item without seeing its secret. Resolve an id or exact name from vault/list_api_keys.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `item` | string | Required |
| `method` | enum: GET\|POST\|PUT\|PATCH\|DELETE | Required |
| `url` | string | Required |
| `headers` | object | Optional |
| `body` | any | Optional |

**Example**

```bash
sulla vault/request '{"item":"<item>","method":"<method>","url":"<url>"}'
```

## set_active_account

Set which account is active for an integration. After setting the active account, all subsequent tool calls for that integration will automatically use its credentials.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `account_type` | string | Required |
| `account_id` | string | Required |

**Example**

```bash
sulla vault/set_active_account '{"account_type":"<account_type>","account_id":"<account_id>"}'
```

## set_credential

Store or update a credential for an integration account. The value is encrypted in the vault and never appears in conversation after this call.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `account_type` | string | Required |
| `property` | string | Required |
| `value` | string | Required |
| `account_id` | string | Optional |
| `confirm` | boolean | Optional |

**Example**

```bash
sulla vault/set_credential '{"account_type":"<account_type>","property":"<property>","value":"<value>"}'
```

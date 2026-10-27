# settings tools

Read and write Sulla Desktop settings through SullaSettingsModel (the single authoritative read-path — never raw Redis sulla_settings).

## get

Read a Sulla Desktop setting through SullaSettingsModel (Redis cache → Postgres → file fallback). Use this instead of redis_hget on sulla_settings — raw Redis reads of that hash are blocked.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `property` | string | Required |
| `default` | string | Optional |

**Example**

```bash
sulla settings/get '{"property":"<property>"}'
```

## set

Write a Sulla Desktop setting through SullaSettingsModel so Postgres and the Redis cache stay in sync. Use this instead of redis_hset on sulla_settings — raw Redis writes of that hash are blocked.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `property` | string | Required |
| `value` | string | Required |
| `cast` | string | Optional |

**Example**

```bash
sulla settings/set '{"property":"<property>","value":"<value>"}'
```

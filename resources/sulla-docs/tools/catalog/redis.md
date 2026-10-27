# redis tools

Redis key/value store operations.

## decr

Decrement the integer value of a Redis key by one.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `key` | string | Required |

**Example**

```bash
sulla redis/decr '{"key":"<key>"}'
```

## del

Delete one or more Redis keys.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `keys` | array | Required |

**Example**

```bash
sulla redis/del '{"keys":"<keys>"}'
```

## expire

Set a timeout on a Redis key.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `key` | string | Required |
| `seconds` | number | Required |

**Example**

```bash
sulla redis/expire '{"key":"<key>","seconds":"<seconds>"}'
```

## get

Get the value of a Redis key.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `key` | string | Required |

**Example**

```bash
sulla redis/get '{"key":"<key>"}'
```

## hget

Get the value of a field in a Redis hash.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `key` | string | Required |
| `field` | string | Required |

**Example**

```bash
sulla redis/hget '{"key":"<key>","field":"<field>"}'
```

## hgetall

Get all fields and values from a Redis hash.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `key` | string | Required |

**Example**

```bash
sulla redis/hgetall '{"key":"<key>"}'
```

## hset

Set the value of a field in a Redis hash.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `key` | string | Required |
| `field` | string | Required |
| `value` | string | Required |

**Example**

```bash
sulla redis/hset '{"key":"<key>","field":"<field>","value":"<value>"}'
```

## incr

Increment the integer value of a Redis key by one.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `key` | string | Required |

**Example**

```bash
sulla redis/incr '{"key":"<key>"}'
```

## lpop

Remove and return the first element of a Redis list.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `key` | string | Required |

**Example**

```bash
sulla redis/lpop '{"key":"<key>"}'
```

## rpush

Append one or more values to a Redis list.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `key` | string | Required |
| `values` | array | Required |

**Example**

```bash
sulla redis/rpush '{"key":"<key>","values":"<values>"}'
```

## set

Set the value of a Redis key.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `key` | string | Required |
| `value` | string | Required |
| `ttl` | number | Optional |

**Example**

```bash
sulla redis/set '{"key":"<key>","value":"<value>"}'
```

## ttl

Get the time to live (TTL) of a Redis key.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `key` | string | Required |

**Example**

```bash
sulla redis/ttl '{"key":"<key>"}'
```

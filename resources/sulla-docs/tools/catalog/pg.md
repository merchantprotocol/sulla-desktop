# pg tools

PostgreSQL database queries and transactions.

## count

Execute a PostgreSQL count query and return the count.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `sql` | string | Required |
| `params` | array | Optional |

**Example**

```bash
sulla pg/count '{"sql":"<sql>"}'
```

## execute

Execute a PostgreSQL statement and return execution results.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `sql` | string | Optional |
| `query` | string | Optional |
| `statement` | string | Optional |
| `params` | array | Optional |

**Example**

```bash
sulla pg/execute '{}'
```

## query

Execute a PostgreSQL query and return results.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `sql` | string | Optional |
| `query` | string | Optional |
| `statement` | string | Optional |
| `params` | array | Optional |

**Example**

```bash
sulla pg/query '{}'
```

## queryall

Execute a PostgreSQL query and return all result rows.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `sql` | string | Required |
| `params` | array | Optional |

**Example**

```bash
sulla pg/queryall '{"sql":"<sql>"}'
```

## queryone

Execute a PostgreSQL query and return the first result row.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `sql` | string | Required |
| `params` | array | Optional |

**Example**

```bash
sulla pg/queryone '{"sql":"<sql>"}'
```

## transaction

Execute multiple PostgreSQL statements in a transaction.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `sql` | string | Required |

**Example**

```bash
sulla pg/transaction '{"sql":"<sql>"}'
```

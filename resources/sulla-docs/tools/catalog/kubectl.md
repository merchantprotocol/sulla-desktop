# kubectl tools

Kubernetes cluster management tools.

## apply

Apply a Kubernetes manifest file.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `file` | string | Required |
| `namespace` | string | Optional |
| `dryRun` | string | Optional |

**Example**

```bash
sulla kubectl/apply '{"file":"<file>"}'
```

## delete

Delete Kubernetes resources.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `resource` | string | Required |
| `name` | string | Required |
| `namespace` | string | Optional |
| `force` | boolean | Optional |
| `gracePeriod` | number | Optional |

**Example**

```bash
sulla kubectl/delete '{"resource":"<resource>","name":"<name>"}'
```

## describe

Describe Kubernetes resources.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `resource` | string | Required |
| `name` | string | Required |
| `namespace` | string | Optional |

**Example**

```bash
sulla kubectl/describe '{"resource":"<resource>","name":"<name>"}'
```

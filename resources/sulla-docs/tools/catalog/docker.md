# docker tools

Tools for Docker container management.

## build

Build a Docker image from a Dockerfile.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `path` | string | Required |
| `tag` | string | Required |
| `options` | string | Optional |

**Example**

```bash
sulla docker/build '{"path":"<path>","tag":"<tag>"}'
```

## exec

Execute a command in a running Docker container.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `container` | string | Required |
| `command` | string | Required |

**Example**

```bash
sulla docker/exec '{"container":"<container>","command":"<command>"}'
```

## images

List Docker images.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `all` | boolean | Optional |

**Example**

```bash
sulla docker/images '{}'
```

## logs

Fetch the logs of a Docker container.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `container` | string | Required |
| `follow` | boolean | Optional |
| `tail` | number | Optional |

**Example**

```bash
sulla docker/logs '{"container":"<container>"}'
```

## ps

List Docker containers.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `all` | boolean | Optional |
| `format` | string | Optional |

**Example**

```bash
sulla docker/ps '{}'
```

## pull

Pull a Docker image from a registry.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `image` | string | Required |

**Example**

```bash
sulla docker/pull '{"image":"<image>"}'
```

## rm

Remove one or more Docker containers.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `container` | string | Required |
| `force` | boolean | Optional |

**Example**

```bash
sulla docker/rm '{"container":"<container>"}'
```

## run

Run a Docker container.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `image` | string | Required |
| `name` | string | Optional |
| `command` | string | Optional |
| `options` | string | Optional |

**Example**

```bash
sulla docker/run '{"image":"<image>"}'
```

## stop

Stop a running Docker container.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `container` | string | Required |

**Example**

```bash
sulla docker/stop '{"container":"<container>"}'
```

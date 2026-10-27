# reflex tools

Reflex decision engine — teach, test, correct, and export the examples Sulla uses to act on a message instantly, before the language model.

## correct

Tell the Reflex engine one of its decisions was wrong. Records a counter-example for that message and action, and — when you pass the correct tool/params (or tool "none") — teaches the right answer too.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `decision_id` | string | Required |
| `tool` | string | Optional |
| `params` | object | Optional |

**Example**

```bash
sulla reflex/correct '{"decision_id":"<decision_id>"}'
```

## export

Export the active Reflex training set as JSON ({version, examples:[{utterance, tool, params, positive}]}) so it can be reviewed or shipped as a production seed. Optionally writes it to a file path; re-import with reflex_teach examples[] and source "seed".

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `path` | string | Optional |

**Example**

```bash
sulla reflex/export '{}'
```

## forget

Forget (soft-archive) a Reflex training example by id. It stops influencing decisions immediately but stays recoverable.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `id` | string | Required |

**Example**

```bash
sulla reflex/forget '{"id":"<id>"}'
```

## list_examples

List Reflex training examples, newest first. Filter by text in the utterance or by tool name.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `query` | string | Optional |
| `tool` | string | Optional |
| `limit` | number | Optional |
| `include_archived` | boolean | Optional |

**Example**

```bash
sulla reflex/list_examples '{}'
```

## predict

Dry-run the Reflex engine on a message: returns the tool/params it would pick, its confidence, the current threshold, whether it would act, and the nearest training examples. Never executes anything.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `message` | string | Required |

**Example**

```bash
sulla reflex/predict '{"message":"<message>"}'
```

## stats

Reflex engine status: enabled flag, confidence threshold, allowed categories, example counts, decision counts by outcome, corrections, and the most recent decisions.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `recent` | number | Optional |

**Example**

```bash
sulla reflex/stats '{}'
```

## teach

Teach the Reflex engine what to do for a user message: map an utterance to ONE Sulla tool call (tool + params) that fully satisfies it, or to tool "none" for messages that should never trigger an action. Set positive:false to teach "do NOT do this for this message".

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `utterance` | string | Optional |
| `tool` | string | Optional |
| `params` | object | Optional |
| `positive` | boolean | Optional |
| `examples` | array | Optional |
| `source` | string | Optional |

**Example**

```bash
sulla reflex/teach '{}'
```

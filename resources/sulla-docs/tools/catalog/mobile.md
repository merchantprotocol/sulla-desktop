# mobile tools

Sulla Mobile companion — check whether signed-in desktop and mobile devices are reachable.

## list_devices

List every desktop and mobile device registered to the account, annotated with online/offline status. A device is "online" when it has hit the worker within the last 2 minutes (heartbeat or any authenticated call).

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `online_only` | boolean | Optional |
| `device_type` | enum: desktop\|mobile | Optional |

**Example**

```bash
sulla mobile/list_devices '{}'
```

# Sulla Functions — Complete Working Examples

## Python: Math (test-python-math)

**function.yaml:**
```yaml
apiVersion: sulla/v1
kind: Function
id: function-test-python-math
name: Test Python Math
description: Computes Fibonacci and primes up to N.
schemaversion: 1
slug: test-python-math
spec:
  runtime: python
  entrypoint: main.py::handler
  inputs:
    n:
      type: integer
      default: 10
  outputs:
    fibonacci:
      type: integer
    primes:
      type: array
  permissions:
    network: []
  timeout: 30s
```

**main.py:**
```python
def handler(inputs):
    n = int(inputs.get("n", 10))

    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    fib = a

    if n < 2:
        primes = []
    else:
        sieve = [True] * (n + 1)
        sieve[0] = sieve[1] = False
        for i in range(2, int(n**0.5) + 1):
            if sieve[i]:
                for j in range(i * i, n + 1, i):
                    sieve[j] = False
        primes = [i for i, v in enumerate(sieve) if v]

    return {"fibonacci": fib, "primes": primes}
```

---

## Node.js: Text Transform (test-node-transform)

**function.yaml:**
```yaml
apiVersion: sulla/v1
kind: Function
id: function-test-node-transform
name: Test Node Transform
description: Transforms text in various ways.
schemaversion: 1
slug: test-node-transform
spec:
  runtime: node
  entrypoint: main.js::handler
  inputs:
    text:
      type: string
      default: "Hello Sulla World"
  outputs:
    reversed:
      type: string
    uppercased:
      type: string
    word_count:
      type: integer
    char_count:
      type: integer
  permissions:
    network: []
  timeout: 5s
```

**main.js:**
```javascript
export async function handler(inputs) {
  const text = String(inputs.text ?? "Hello Sulla World");
  return {
    reversed:   text.split("").reverse().join(""),
    uppercased: text.toUpperCase(),
    word_count: text.trim().split(/\s+/).filter(Boolean).length,
    char_count:  text.length,
  };
}
```

**package.json:**
```json
{
  "name": "test-node-transform",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "main.js"
}
```

---

## Shell: System Info (test-shell-sysinfo)

**function.yaml:**
```yaml
apiVersion: sulla/v1
kind: Function
id: function-test-shell-sysinfo
name: Test Shell Sysinfo
description: Returns system info from inside the shell container.
schemaversion: 1
slug: test-shell-sysinfo
spec:
  runtime: shell
  entrypoint: main.sh
  inputs:
    detail:
      type: string
      default: basic
      description: "basic or full"
  outputs:
    hostname:
      type: string
    uptime:
      type: string
    arch:
      type: string
    os_info:
      type: string
  permissions:
    network: []
  timeout: 10s
```

**main.sh:**
```bash
#!/usr/bin/env bash
set -euo pipefail

DETAIL="${INPUT_detail:-basic}"
HOSTNAME_VAL="$(hostname)"
ARCH_VAL="$(uname -m)"
OS_INFO="$(uname -sr)"

if [ "$DETAIL" = "full" ]; then
  UPTIME_VAL="$(uptime)"
else
  UPTIME_VAL="$(uptime | awk -F',' '{print $1}' | sed 's/^ *//')"
fi

cat <<JSON
{
  "hostname": "$HOSTNAME_VAL",
  "uptime":   "$UPTIME_VAL",
  "arch":     "$ARCH_VAL",
  "os_info":  "$OS_INFO"
}
JSON
```

---

## Python: Cache Read (production pattern)

**main.py:**
```python
import json
import os
from datetime import datetime, timezone

CACHE_FILE = os.path.expanduser("~/sulla/workflows/social-media-posts/audience-cache.json")

def handler(inputs):
    max_age_days = inputs.get("max_age_days", 7)

    if not os.path.exists(CACHE_FILE):
        return {"exists": False, "needs_refresh": True, "age_days": None, "cache": None}

    try:
        with open(CACHE_FILE) as f:
            cache = json.load(f)
    except (json.JSONDecodeError, OSError):
        return {"exists": False, "needs_refresh": True, "age_days": None, "cache": None}

    last_updated = cache.get("last_updated", "1970-01-01T00:00:00Z")
    try:
        lu = datetime.fromisoformat(last_updated.replace("Z", "+00:00"))
        age_days = (datetime.now(timezone.utc) - lu).days
    except ValueError:
        age_days = 999

    return {
        "exists": True,
        "needs_refresh": age_days >= max_age_days,
        "age_days": age_days,
        "cache": cache,
    }
```

Demonstrates: defensive file reads, date comparison, returning mixed types (bool + int + object).

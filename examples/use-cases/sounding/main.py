# SPDX-License-Identifier: Apache-2.0
from collections import Counter
import math

def handler(inputs):
    rows = inputs.get("rows") or []
    keys = inputs.get("key_columns") or []
    names = sorted({str(k) for r in rows if isinstance(r, dict) for k in r})
    cols = {}
    warnings = []
    for name in names:
        vals = [r.get(name) if isinstance(r, dict) else None for r in rows]
        nonnull = [v for v in vals if v not in (None, "")]
        numeric = [float(v) for v in nonnull if isinstance(v, (int,float)) and not isinstance(v,bool)]
        item = {"null_count": len(vals)-len(nonnull), "null_rate": (len(vals)-len(nonnull))/len(vals) if vals else 0, "unique_count": len({repr(v) for v in nonnull})}
        if numeric:
            item["numeric"] = {"min": min(numeric), "max": max(numeric), "mean": sum(numeric)/len(numeric)}
            if len(numeric) >= 4:
                mean = sum(numeric)/len(numeric); sd = math.sqrt(sum((x-mean)**2 for x in numeric)/len(numeric))
                item["outlier_count"] = sum(abs(x-mean) > 3*sd for x in numeric) if sd else 0
        cols[name] = item
        if item["null_rate"] > 0.5: warnings.append(f"{name}: more than half the values are missing")
    duplicates = len(rows) - len({repr(sorted(r.items())) for r in rows if isinstance(r, dict)})
    result = {"rows": len(rows), "columns": cols, "duplicate_rows": duplicates}
    if keys:
        seen = Counter(tuple(r.get(k) for k in keys) for r in rows if isinstance(r, dict))
        result["duplicate_keys"] = sum(n-1 for n in seen.values() if n > 1)
    if duplicates: warnings.append(f"{duplicates} duplicate row(s) detected")
    return {"profile": result, "warnings": warnings}

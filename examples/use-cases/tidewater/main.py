from datetime import date, datetime, timedelta

def _date(value):
    return datetime.fromisoformat(str(value).replace("Z", "+00:00")).date()

def handler(inputs: dict) -> dict:
    as_of = _date(inputs["as_of"])
    rows = inputs.get("rows", [])
    horizons = inputs.get("horizons", [30, 60, 90])
    warnings = []
    parsed = []
    for i, row in enumerate(rows):
        try:
            amount = float(row["amount"])
            kind = str(row.get("kind", "")).lower()
            if kind not in ("income", "expense"):
                raise ValueError("kind must be income or expense")
            parsed.append((_date(row["date"]), amount if kind == "income" else -amount, bool(row.get("recurring", False))))
        except (KeyError, TypeError, ValueError) as exc:
            warnings.append(f"Skipped row {i}: {exc}")
    if not parsed:
        return {"forecast": [], "warnings": warnings + ["No valid rows supplied."]}
    historical = [amount for day, amount, _ in parsed if day <= as_of]
    opening = sum(historical)
    recent = [amount for day, amount, _ in parsed if as_of - timedelta(days=90) < day <= as_of]
    recurring = [amount for day, amount, is_recurring in parsed if is_recurring and day <= as_of]
    daily = (sum(recent) / 90.0) if recent else 0.0
    recurring_daily = (sum(recurring) / max(1, len(recurring) * 30.0)) if recurring else 0.0
    if not recent:
        warnings.append("No transactions in the prior 90 days; forecast uses the opening balance only.")
    forecast = []
    for horizon in horizons:
        days = int(horizon)
        base = opening + (daily + recurring_daily) * days
        spread = max(abs(base - opening) * 0.25, abs(daily + recurring_daily) * days * 0.5)
        forecast.append({"days": days, "opening_balance": round(opening, 2), "base": round(base, 2), "low": round(base - spread, 2), "high": round(base + spread, 2)})
    return {"forecast": forecast, "warnings": warnings}

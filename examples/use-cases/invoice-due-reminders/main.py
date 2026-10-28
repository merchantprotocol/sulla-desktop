from datetime import date, timedelta


def handler(inputs: dict) -> dict:
    as_of = date.fromisoformat(inputs["as_of"])
    window = max(0, int(inputs.get("within_days", 7)))
    end = as_of + timedelta(days=window)
    reminders = []
    for invoice in inputs.get("invoices", []):
        if str(invoice.get("status", "")).lower() in {"paid", "void", "cancelled", "canceled"}:
            continue
        due = date.fromisoformat(str(invoice["due_date"]))
        if as_of <= due <= end:
            customer = str(invoice.get("customer", "Customer"))
            amount = invoice.get("amount", "")
            currency = invoice.get("currency", "")
            reminders.append({
                "invoice_id": invoice.get("id"),
                "customer": customer,
                "due_date": due.isoformat(),
                "subject": f"Invoice {invoice.get('id', '')} due {due.isoformat()}",
                "body": f"Hi {customer}, a balance of {currency} {amount} is due on {due.isoformat()}. Please let us know if you need anything.",
            })
    reminders.sort(key=lambda item: (item["due_date"], str(item["invoice_id"])))
    return {"reminders": reminders, "count": len(reminders)}

"""Fetch a Stripe invoice by ID.

Entrypoint for the fetch-stripe-invoice routine. The runtime container calls
`handler(inputs: dict) -> dict` and passes validated inputs that conform to
the JSON Schema declared in routine.yaml.
"""

import os
from typing import Any

import stripe


def handler(inputs: dict[str, Any]) -> dict[str, Any]:
    stripe.api_key = os.environ["STRIPE_KEY"]

    invoice_id = inputs["invoice_id"]
    include_line_items = inputs.get("include_line_items", True)

    try:
        invoice = stripe.Invoice.retrieve(
            invoice_id,
            expand=["lines"] if include_line_items else [],
        )
    except stripe.error.InvalidRequestError as err:
        if getattr(err, "code", None) == "resource_missing":
            return {"invoice": None}
        raise

    return {"invoice": invoice.to_dict()}
